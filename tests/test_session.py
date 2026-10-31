import asyncio
import json
import logging
import os
import struct
import subprocess
import sys
import tempfile
import types
import textwrap
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path

from session_core import ProcessMemory, SessionStore, pack_value, unpack_value, parse_address, normalize_auto_value

ROOT = Path(__file__).resolve().parents[1]

class Values(unittest.TestCase):
    def test_unsigned_64_bit_round_trip_without_javascript_precision_loss(self):
        number = '18446744073709551615'
        self.assertEqual(unpack_value('uint64', pack_value('uint64', number)), number)

    def test_float_negative_and_range_checks(self):
        self.assertEqual(unpack_value('float32', pack_value('float32', '-73.125')), '-73.125')
        self.assertEqual(unpack_value('int8', pack_value('int8', '-128')), '-128')
        for kind, text in [('uint8', '-1'), ('int8', '128'), ('float32', '1e100'), ('float64', 'nan')]:
            with self.subTest(kind=kind, text=text), self.assertRaises(ValueError):
                pack_value(kind, text)

    def test_auto_normalizes_without_losing_large_integer_precision(self):
        self.assertEqual(normalize_auto_value('18446744073709551615'), '18446744073709551615')
        self.assertEqual(normalize_auto_value('4.0'), '4.0')
        self.assertEqual(normalize_auto_value('-73.125'), '-73.125')
        for text in ('1; reset', 'nan', '1e999', '18446744073709551616'):
            with self.assertRaises(ValueError):
                normalize_auto_value(text)

    def test_hex_addresses_and_command_input_rejection(self):
        self.assertEqual(parse_address('0xabcdef'), 0xabcdef)
        for address in ['0x0', '-1', '12; reset', '0xffffffffffffffff']:
            with self.assertRaises(ValueError):
                parse_address(address)

class Backend(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.target = subprocess.Popen([sys.executable, str(ROOT / 'tests' / 'memory_target.py')],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.target_info = json.loads(self.target.stdout.readline())
        self.memory = ProcessMemory()
        self.pid = self.target_info['pid']
        self.addresses = self.target_info['addresses']
        sys.modules['decky'] = types.SimpleNamespace(DECKY_PLUGIN_SETTINGS_DIR=self.temp.name, logger=logging.getLogger('test'))
        import main
        main.decky = sys.modules['decky']
        self.plugin = main.Plugin()
        await self.plugin._main()
        self.addCleanup(self.stop_target)
        self.addAsyncCleanup(self.plugin._unload)
        await self.plugin.attach(self.pid, self.memory.identity(self.pid))

    def stop_target(self):
        if self.target.poll() is None:
            self.target.terminate()
            self.target.wait(timeout=3)
        self.target.stdin.close()
        self.target.stdout.close()
        self.temp.cleanup()

    def target_value(self, kind, value=None):
        message = {'kind': kind}
        if value is not None:
            message['value'] = value
        self.target.stdin.write(json.dumps(message) + '\n')
        self.target.stdin.flush()
        return json.loads(self.target.stdout.readline())['value']

    async def save(self, name='Gold', kind='int32'):
        state = await self.plugin.save_entry(name, self.addresses[kind], kind)
        return state['session']['entries'][-1]['id']

    async def test_reopen_refreshes_actual_memory_and_marks_change_without_write(self):
        entry_id = await self.save()
        self.target_value('int32', 12345)
        state = await self.plugin.get_state(True)  # Same endpoint used on every panel mount.
        entry = state['session']['entries'][0]
        self.assertEqual((entry['id'], entry['name'], entry['value']), (entry_id, 'Gold', '12345'))
        self.assertTrue(entry['changed'])
        self.assertEqual(entry['previous'], '1379467285')
        self.assertEqual(self.target_value('int32'), '12345')
        self.assertFalse((await self.plugin.get_state(True))['session']['entries'][0]['changed'])

    async def test_saved_entries_survive_native_scan_refine_reset_and_same_process_attach(self):
        entry_id = await self.save()
        state = await self.plugin.scan('equal', '1379467285', 'int32')
        self.assertGreater(state['scan']['count'], 0)
        self.assertIn(self.addresses['int32'], [row['address'] for row in state['scan']['results']])
        count = state['scan']['count']
        state = await self.plugin.attach(self.pid, self.memory.identity(self.pid))
        self.assertEqual(state['scan']['count'], count)
        state = await self.plugin.get_state(True)
        self.assertEqual(state['scan']['count'], count)
        self.target_value('int32', 7654321)
        state = await self.plugin.scan('equal', '7654321', 'int32')
        self.assertIn(self.addresses['int32'], [row['address'] for row in state['scan']['results']])
        state = await self.plugin.reset_scan()
        self.assertFalse(state['scan']['has_scan'])
        self.assertEqual(state['session']['entries'][0]['id'], entry_id)
        await self.plugin.write_entry(entry_id, '-9876')
        self.assertEqual(self.target_value('int32'), '-9876')

    async def test_auto_integer_scan_returns_concrete_types_and_can_save(self):
        self.assertEqual(self.plugin.store.scan['kind'], 'auto')
        state = await self.plugin.scan('equal', '1379467285', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['int32'])
        self.assertIn('int32', row['candidate_kinds'])
        self.assertEqual(row['values']['int32'], '1379467285')
        self.assertNotEqual(row['kind'], 'auto')
        group_state = await self.plugin.save_entries('Auto Gold', [{'address': row['address'], 'kind': 'int32'}], '')
        entry = group_state['session']['entries'][0]
        await self.plugin.reset_scan()
        await self.plugin.write_entry(entry['id'], '555')
        self.assertEqual(self.target_value('int32'), '555')
        self.assertEqual(self.target_value('int32_copy'), '1379467285')

    async def test_auto_decimal_scan_keeps_float_family_on_whole_number_refinement(self):
        state = await self.plugin.scan('equal', '-73.125', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['float32'])
        self.assertIn('float32', row['candidate_kinds'])
        self.assertTrue(all(k.startswith('float') for k in row['candidate_kinds']))
        self.target_value('float32', -80.0)
        state = await self.plugin.scan('equal', '-80', 'auto')
        self.assertIn(self.addresses['float32'], [r['address'] for r in state['scan']['results']])
        await self.plugin.reset_scan()
        state = await self.plugin.scan('equal', '17382.625', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['float64'])
        self.assertEqual(row['kind'], 'float64')

    async def test_auto_handles_ambiguous_widths_and_unsigned_64_bit_values(self):
        state = await self.plugin.scan('equal', '1379467285', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['int32_copy'])
        self.assertIn('int32', row['candidate_kinds'])
        self.assertIn('int64', row['candidate_kinds'])
        self.assertEqual(row['values']['int64'], '1379467285')
        await self.plugin.reset_scan()
        state = await self.plugin.scan('equal', '18446744073709551601', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['uint64'])
        self.assertIn('uint64', row['candidate_kinds'])
        self.assertEqual(row['values']['uint64'], '18446744073709551601')

    async def test_auto_unknown_initial_can_refine_to_a_float_value(self):
        state = await self.plugin.scan('unknown', '', 'auto')
        self.assertTrue(state['scan']['has_scan'])
        self.assertGreater(state['scan']['count'], 200)
        self.assertTrue(all(row['kind'] != 'auto' for row in state['scan']['results']))
        self.target_value('float64', 38912.625)
        state = await self.plugin.scan('equal', '38912.625', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['float64'])
        self.assertIn('float64', row['candidate_kinds'])
        self.assertEqual(row['values']['float64'], '38912.625')

    async def test_group_keeps_two_addresses_with_independent_writes_and_removal(self):
        state = await self.plugin.save_entries('Gold', [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['int32_copy'], 'kind': 'int32'}], '')
        group_id = state['session']['groups'][0]['id']
        first, second = state['session']['entries']
        self.assertEqual(first['group_id'], second['group_id'])
        await self.plugin.write_entry(first['id'], '111')
        self.assertEqual(self.target_value('int32'), '111')
        self.assertEqual(self.target_value('int32_copy'), '1379467285')
        await self.plugin.write_entry(second['id'], '222')
        self.assertEqual(self.target_value('int32'), '111')
        self.assertEqual(self.target_value('int32_copy'), '222')
        state = await self.plugin.get_state(True)
        self.assertEqual([e['value'] for e in state['session']['entries']], ['111', '222'])
        await self.plugin.freeze_entry(first['id'], True)
        state = await self.plugin.remove_entry(first['id'])
        self.target_value('int32', 333)
        self.plugin.store.tick_freezes()
        self.assertEqual(self.target_value('int32'), '333')
        self.assertEqual([e['id'] for e in state['session']['entries']], [second['id']])
        await self.plugin.remove_entry(second['id'])
        self.assertEqual(self.plugin.store.session['groups'][0]['id'], group_id)
        self.assertFalse(self.plugin.store.session['entries'])
        await self.plugin.save_entries('', [{'address': self.addresses['int32'], 'kind': 'int32'}], group_id)
        self.assertEqual(len(self.plugin.store.session['groups']), 1)

    async def test_group_write_updates_all_members_and_frozen_targets_only_in_that_group(self):
        state = await self.plugin.save_entries('Gold', [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['int32_copy'], 'kind': 'int32'},
            {'address': self.addresses['float32'], 'kind': 'float32'}], '')
        group = state['session']['groups'][0]
        first = state['session']['entries'][0]
        await self.plugin.freeze_entry(first['id'], True)
        await self.plugin.save_entries('Other group', [{'address': self.addresses['uint64'], 'kind': 'uint64'}], '')
        state = await self.plugin.write_group(group['id'], '123')
        report = state['group_write']
        self.assertEqual((report['total'], len(report['written']), report['failed']), (3, 3, []))
        self.assertEqual(self.target_value('int32'), '123')
        self.assertEqual(self.target_value('int32_copy'), '123')
        self.assertEqual(self.target_value('float32'), '123.0')
        self.assertEqual(self.target_value('uint64'), '18446744073709551601')
        self.target_value('int32', 1)
        self.plugin.store.tick_freezes()
        self.assertEqual(self.target_value('int32'), '123')
        self.assertEqual(self.plugin.store.entry(first['id'])['freeze_value'], '123')

    async def test_group_preflight_rejects_type_range_or_unavailable_address_before_any_write(self):
        state = await self.plugin.save_entries('Mixed', [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['float32'], 'kind': 'uint8'}], '')
        group = state['session']['groups'][0]
        with self.assertRaisesRegex(ValueError, 'No addresses were changed'):
            await self.plugin.write_group(group['id'], '300')
        self.assertEqual(self.target_value('int32'), '1379467285')
        await self.plugin.save_entries('', [{'address': '0x123', 'kind': 'int32'}], group['id'])
        with self.assertRaisesRegex(ValueError, 'No addresses were changed'):
            await self.plugin.write_group(group['id'], '123')
        self.assertEqual(self.target_value('int32'), '1379467285')

    async def test_group_write_reports_a_mid_write_failure_and_stops_its_freeze(self):
        state = await self.plugin.save_entries('Gold', [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['int32_copy'], 'kind': 'int32'}], '')
        group = state['session']['groups'][0]
        failed_id = state['session']['entries'][1]['id']
        await self.plugin.freeze_entry(failed_id, True)
        real_write = os.pwrite
        bad_address = int(self.addresses['int32_copy'], 16)
        def write(fd, data, address):
            if address == bad_address:
                raise OSError('Test address disappeared after preflight')
            return real_write(fd, data, address)
        with patch('session_core.os.pwrite', side_effect=write):
            state = await self.plugin.write_group(group['id'], '456')
        self.assertEqual(len(state['group_write']['written']), 1)
        self.assertEqual(state['group_write']['failed'][0]['id'], failed_id)
        self.assertFalse(self.plugin.store.entry(failed_id)['frozen'])
        self.assertEqual(self.target_value('int32'), '456')
        self.assertEqual(self.target_value('int32_copy'), '1379467285')

    async def test_group_write_rejects_conflicting_overlap_and_empty_groups(self):
        state = await self.plugin.save_entries('Overlap', [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['int32'], 'kind': 'float32'}], '')
        group = state['session']['groups'][0]
        with self.assertRaisesRegex(ValueError, 'overlap'):
            await self.plugin.write_group(group['id'], '5')
        self.assertEqual(self.target_value('int32'), '1379467285')
        for entry in list(self.plugin.store.session['entries']):
            await self.plugin.remove_entry(entry['id'])
        with self.assertRaisesRegex(ValueError, 'no addresses'):
            await self.plugin.write_group(group['id'], '5')

    async def test_real_native_worker_streams_progress_frames_without_losing_result(self):
        worker = self.plugin.worker
        await worker.request(action='attach', pid=self.pid)
        progress = []
        result = await worker.request(action='scan', kind='int32', operator='equal',
                                      value='1379467285', on_progress=progress.append)
        self.assertGreater(result['count'], 0)
        self.assertEqual((progress[0], progress[-1]), (0.0, 1.0))
        self.assertTrue(all(0 <= value <= 1 for value in progress))
        # Frames from one request must not contaminate the following request.
        self.assertEqual(await worker.request(action='reset'), {})

    async def test_scan_progress_is_readable_while_request_is_in_flight(self):
        self.plugin.worker_identity = self.plugin.store.active
        self.plugin.worker.process = types.SimpleNamespace(returncode=None)
        started, finish = asyncio.Event(), asyncio.Event()
        async def scan(on_progress=None, **request):
            on_progress(0.42)
            started.set()
            await finish.wait()
            on_progress(1.0)
            return {'count': 0, 'results': []}
        self.plugin.worker.request = scan
        self.plugin.worker.close = AsyncMock()
        task = asyncio.create_task(self.plugin.scan('equal', '1', 'int32'))
        try:
            await asyncio.wait_for(started.wait(), 1)
            state = await asyncio.wait_for(self.plugin.get_state(False), 1)
            self.assertTrue(state['scan']['busy'])
            self.assertEqual(state['scan']['progress'], 0.42)
        finally:
            finish.set()
            await task
        self.assertEqual(self.plugin.store.scan['progress'], 1.0)
        self.assertFalse(self.plugin.store.scan['busy'])

    async def test_add_move_rename_and_delete_groups(self):
        first_id = await self.save('Gold')
        state = await self.plugin.save_entries('Health', [{'address': self.addresses['float32'], 'kind': 'float32'}], '')
        gold, health = state['session']['groups']
        state = await self.plugin.save_entries('', [{'address': self.addresses['uint64'], 'kind': 'uint64'}], gold['id'])
        self.assertEqual(len(state['session']['groups']), 2)
        self.assertEqual(sum(e['group_id'] == gold['id'] for e in state['session']['entries']), 2)
        await self.plugin.move_entry(first_id, health['id'])
        await self.plugin.rename_group(health['id'], 'Player health')
        self.assertEqual(self.plugin.store.entry(first_id)['group_id'], health['id'])
        self.assertEqual(self.target_value('int32'), '1379467285')
        restored = SessionStore(Path(self.temp.name) / 'sessions.json')
        self.assertEqual(restored.group(health['id'])['name'], 'Player health')
        self.assertEqual(restored.entry(first_id)['group_id'], health['id'])
        await self.plugin.freeze_entry(first_id, True)
        await self.plugin.remove_group(health['id'])
        self.target_value('int32', 333)
        self.plugin.store.tick_freezes()
        self.assertEqual(self.target_value('int32'), '333')
        self.assertEqual([g['id'] for g in self.plugin.store.session['groups']], [gold['id']])
        self.assertTrue(all(e['group_id'] == gold['id'] for e in self.plugin.store.session['entries']))

    async def test_invalid_batch_and_duplicate_do_not_partly_create_a_group(self):
        await self.save()
        group_id = self.plugin.store.session['groups'][0]['id']
        with self.assertRaises(ValueError):
            await self.plugin.save_entries('Bad batch', [
                {'address': self.addresses['float32'], 'kind': 'float32'},
                {'address': 'not hex', 'kind': 'int32'}], '')
        self.assertEqual(len(self.plugin.store.session['groups']), 1)
        self.assertEqual(len(self.plugin.store.session['entries']), 1)
        with self.assertRaises(ValueError):
            await self.plugin.save_entries('', [{'address': self.addresses['int32'], 'kind': 'int32'}], group_id)
        with self.assertRaises(ValueError):
            await self.plugin.save_entries('Duplicate batch', [
                {'address': self.addresses['float32'], 'kind': 'float32'},
                {'address': self.addresses['float32'], 'kind': 'float32'}], '')
        self.assertEqual(len(self.plugin.store.session['entries']), 1)
        with self.assertRaises(ValueError):
            await self.plugin.save_entries('GOLD', [{'address': self.addresses['float32'], 'kind': 'float32'}], '')

    async def test_legacy_entries_migrate_to_groups_without_losing_addresses(self):
        await self.save('Gold')
        state = await self.plugin.save_entry('Health', self.addresses['float32'], 'float32')
        legacy = json.loads(json.dumps(state['session']))
        legacy.pop('groups')
        for entry in legacy['entries']:
            entry.pop('group_id')
            entry['name'] = 'Gold'
            entry['frozen'] = True
        ids = [e['id'] for e in legacy['entries']]
        path = Path(self.temp.name) / 'legacy.json'
        old_bytes = json.dumps({'version': 1, 'active': legacy['id'], 'sessions': {legacy['id']: legacy}})
        path.write_text(old_bytes)
        restored = SessionStore(path)
        self.assertEqual(len(restored.session['groups']), 1)
        self.assertEqual(restored.session['groups'][0]['name'], 'Gold')
        self.assertEqual([e['id'] for e in restored.session['entries']], ids)
        self.assertFalse(any(e['frozen'] for e in restored.session['entries']))
        restored.refresh()
        self.assertEqual(json.loads(path.read_text())['version'], 2)
        self.assertEqual(path.with_name('legacy.v1-backup.json').read_text(), old_bytes)
        self.assertEqual([e['value'] for e in restored.session['entries']], ['1379467285', '-73.125'])

    async def test_native_float_scan(self):
        state = await self.plugin.scan('equal', '-73.125', 'float32')
        self.assertIn(self.addresses['float32'], [row['address'] for row in state['scan']['results']])
        self.target_value('float32', -81.25)
        state = await self.plugin.scan('decreased', '', 'float32')
        self.assertIn(self.addresses['float32'], [row['address'] for row in state['scan']['results']])

    async def test_exact_delta_filters_other_changes_and_uses_latest_search_baseline(self):
        initial = 1379467285
        await self.plugin.scan('equal', str(initial), 'int32')
        self.target_value('int32', initial + 25)
        self.target_value('int32_copy', initial + 24)
        state = await self.plugin.scan('increased_by', '25', 'int32')
        addresses = [r['address'] for r in state['scan']['results']]
        self.assertIn(self.addresses['int32'], addresses)
        self.assertNotIn(self.addresses['int32_copy'], addresses)
        self.target_value('int32', initial + 50)
        state = await self.plugin.scan('increased_by', '25', 'int32')
        self.assertIn(self.addresses['int32'], [r['address'] for r in state['scan']['results']])
        self.target_value('int32', initial + 43)
        state = await self.plugin.scan('decreased_by', '7', 'int32')
        self.assertIn(self.addresses['int32'], [r['address'] for r in state['scan']['results']])

    async def test_auto_unknown_delta_keeps_integer_and_float_matches(self):
        await self.plugin.scan('unknown', '', 'auto')
        self.target_value('int32', 1379467290)
        self.target_value('float32', -68.125)
        state = await self.plugin.scan('increased_by', '5', 'auto')
        rows = {r['address']: r for r in state['scan']['results']}
        self.assertIn('int32', rows[self.addresses['int32']]['candidate_kinds'])
        self.assertIn('float32', rows[self.addresses['float32']]['candidate_kinds'])
        self.target_value('float32', -66.625)
        state = await self.plugin.scan('increased_by', '1.5', 'auto')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['float32'])
        self.assertTrue(all(k.startswith('float') for k in row['candidate_kinds']))

    async def test_exact_delta_handles_floats_and_uint64_without_precision_loss(self):
        await self.plugin.scan('equal', '17382.625', 'auto')
        self.target_value('float64', 17387.625)
        state = await self.plugin.scan('increased_by', '5', 'auto')
        self.assertIn(self.addresses['float64'], [r['address'] for r in state['scan']['results']])
        self.target_value('float64', 17387.5)
        state = await self.plugin.scan('decreased_by', '0.125', 'auto')
        self.assertIn(self.addresses['float64'], [r['address'] for r in state['scan']['results']])
        await self.plugin.reset_scan()
        await self.plugin.scan('equal', '18446744073709551601', 'uint64')
        self.target_value('uint64', 18446744073709551602)
        state = await self.plugin.scan('increased_by', '1', 'uint64')
        row = next(r for r in state['scan']['results'] if r['address'] == self.addresses['uint64'])
        self.assertEqual(row['value'], '18446744073709551602')

    async def test_delta_requires_initial_search_and_positive_amount_without_losing_baseline(self):
        with self.assertRaisesRegex(ValueError, 'initial search'):
            await self.plugin.scan('increased_by', '5', 'auto')
        await self.plugin.scan('equal', '1379467285', 'auto')
        count = self.plugin.store.scan['count']
        for amount in ('0', '-5', '', 'nan', '1; reset'):
            with self.subTest(amount=amount), self.assertRaises(ValueError):
                await self.plugin.scan('increased_by', amount, 'auto')
            self.assertEqual(self.plugin.store.scan['count'], count)
            self.assertFalse(self.plugin.store.scan['busy'])
        self.target_value('int32', 1379467290)
        state = await self.plugin.scan('increased_by', '5', 'auto')
        self.assertIn(self.addresses['int32'], [r['address'] for r in state['scan']['results']])

    async def test_exact_float_delta_excludes_unchanged_values_when_delta_rounds_away(self):
        self.target_value('float64', 1e30)
        await self.plugin.scan('equal', '1e30', 'float64')
        state = await self.plugin.scan('increased_by', '5', 'float64')
        self.assertNotIn(self.addresses['float64'], [r['address'] for r in state['scan']['results']])
        await self.plugin.reset_scan()
        self.target_value('float64', -1e30)
        await self.plugin.scan('equal', '-1e30', 'float64')
        state = await self.plugin.scan('decreased_by', '5', 'float64')
        self.assertNotIn(self.addresses['float64'], [r['address'] for r in state['scan']['results']])

    async def test_invalid_address_retained_and_good_entries_still_refresh(self):
        await self.save()
        state = await self.plugin.save_entry('Unavailable', '0x123', 'int32')
        self.assertEqual(len(state['session']['entries']), 2)
        self.assertEqual(state['session']['entries'][1]['status'], 'unavailable')
        self.target_value('int32', 456)
        state = await self.plugin.get_state(True)
        self.assertEqual(state['session']['entries'][0]['value'], '456')
        self.assertEqual(state['session']['entries'][1]['name'], 'Unavailable')

    async def test_freezing_editing_and_reload_never_auto_resumes_writes(self):
        entry_id = await self.save()
        await self.plugin.freeze_entry(entry_id, True)
        self.target_value('int32', 99)
        self.plugin.store.tick_freezes()
        self.assertEqual(self.target_value('int32'), '1379467285')
        await self.plugin.write_entry(entry_id, '222')
        self.target_value('int32', 0)
        self.plugin.store.tick_freezes()
        self.assertEqual(self.target_value('int32'), '222')
        restored = SessionStore(Path(self.temp.name) / 'sessions.json')
        self.assertFalse(restored.session['entries'][0]['frozen'])
        restored.refresh()
        self.assertEqual(restored.session['entries'][0]['name'], 'Gold')
        self.assertEqual(restored.session['entries'][0]['value'], '222')

    async def test_exit_and_pid_reuse_block_writes(self):
        entry_id = await self.save()
        self.plugin.store.session['id'] += ':different-start-time'
        with self.assertRaises(ProcessLookupError):
            await self.plugin.write_entry(entry_id, '0')
        self.assertEqual(self.target_value('int32'), '1379467285')
        state = await self.plugin.get_state(True)
        self.assertFalse(state['alive'])
        self.assertEqual(state['session']['entries'][0]['status'], 'exited')
        self.assertEqual(state['session']['entries'][0]['name'], 'Gold')

    async def test_actual_game_exit_retains_entries_and_stops_freezes(self):
        entry_id = await self.save()
        await self.plugin.freeze_entry(entry_id, True)
        self.target.terminate()
        self.target.wait(timeout=3)
        self.plugin.store.tick_freezes()
        state = await self.plugin.get_state(True)
        self.assertFalse(state['alive'])
        self.assertEqual(state['session']['entries'][0]['name'], 'Gold')
        self.assertEqual(state['session']['entries'][0]['status'], 'exited')
        self.assertFalse(state['session']['entries'][0]['frozen'])

    async def test_refresh_and_freezes_continue_during_long_search(self):
        entry_id = await self.save()
        await self.plugin.freeze_entry(entry_id, True)
        self.plugin.worker_identity = self.plugin.store.active
        self.plugin.worker.process = types.SimpleNamespace(returncode=None)
        started, finish = asyncio.Event(), asyncio.Event()
        async def slow_scan(**request):
            started.set()
            await finish.wait()
            return {'count': 0, 'results': []}
        self.plugin.worker.request = slow_scan
        self.plugin.worker.close = AsyncMock()
        task = asyncio.create_task(self.plugin.scan('equal', '1379467285', 'int32'))
        try:
            await asyncio.wait_for(started.wait(), 1)
            state = await asyncio.wait_for(self.plugin.get_state(True), 1)
            self.assertTrue(state['scan']['busy'])
            with self.assertRaises(ValueError):
                await self.plugin.reset_scan()
            self.target_value('int32', 98)
            # Use the real background scheduler, rather than calling its tick.
            for _ in range(20):
                if self.target_value('int32') == '1379467285':
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(self.target_value('int32'), '1379467285')
        finally:
            finish.set()
            await task
        self.assertFalse((await self.plugin.get_state(False))['scan']['busy'])

    async def test_rename_delete_and_uint64(self):
        entry_id = await self.save('Large value', 'uint64')
        state = await self.plugin.write_entry(entry_id, '18446744073709551615')
        self.assertEqual(state['session']['entries'][0]['value'], '18446744073709551615')
        await self.plugin.rename_entry(entry_id, 'Inventory counter')
        self.assertEqual(self.plugin.store.entry(entry_id)['name'], 'Inventory counter')
        state = await self.plugin.remove_entry(entry_id)
        self.assertFalse(state['session']['entries'])

    async def test_unknown_initial_value_then_changed(self):
        state = await self.plugin.scan('unknown', '', 'int32')
        self.assertGreater(state['scan']['count'], 200)
        self.assertLessEqual(len(state['scan']['results']), 200)
        self.target_value('int32', 444)
        state = await self.plugin.scan('changed', '', 'int32')
        # This search is allowed even when a broad snapshot yielded >200 results.
        self.assertTrue(state['scan']['has_scan'])
        self.assertGreater(state['scan']['count'], 0)

class ProgressProtocol(unittest.TestCase):
    def test_progress_remains_streamed_during_native_stdout_capture(self):
        program = textwrap.dedent("""
            import os, tempfile, time
            import scanner_worker
            class Lib:
                progress = 1.0
                def sm_get_scan_progress(self): return self.progress
                def sm_cleanup(self): pass
            class FakeScanner:
                def __init__(self): self.lib = Lib()
                def handle(self, request):
                    saved = os.dup(1)
                    try:
                        with tempfile.TemporaryFile() as output:
                            os.dup2(output.fileno(), 1)
                            os.write(1, b'Native output must not enter the JSON protocol')
                            for value in (0.2, 0.5, 0.8):
                                self.lib.progress = value
                                time.sleep(0.15)
                    finally:
                        os.dup2(saved, 1)
                        os.close(saved)
                    return {'count': 1, 'results': []}
            scanner_worker.Scanner = FakeScanner
            scanner_worker.main()
        """)
        completed = subprocess.run([sys.executable, '-c', program], cwd=ROOT,
                                   input='{"action":"scan"}\n', text=True,
                                   capture_output=True, check=True, timeout=5)
        frames = [json.loads(line) for line in completed.stdout.splitlines()]
        progress = [frame['progress'] for frame in frames if frame.get('event') == 'scan_progress']
        self.assertEqual((progress[0], progress[-1]), (0.0, 1.0))
        self.assertTrue(any(0 < value < 1 for value in progress))
        self.assertTrue(frames[-1]['ok'])
        self.assertEqual(frames[-1]['data']['count'], 1)

class Storage(unittest.TestCase):
    def test_corrupt_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sessions.json'
            path.write_text('not json')
            store = SessionStore(path)
            self.assertIsNotNone(store.storage_warning)
            with self.assertRaises(RuntimeError):
                store.persist()
            self.assertEqual(path.read_text(), 'not json')

if __name__ == '__main__':
    unittest.main()
