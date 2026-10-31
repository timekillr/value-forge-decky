"""Exercise the real TLS API against the opt-in memory-test process."""
import asyncio
import contextlib
import hashlib
import json
import ssl
import uuid
from unittest.mock import patch
import test_session as fixtures


class Companion(fixtures.Backend):
    # Reuse the target-process fixture, not the base class's entire test suite.
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.remote = self.plugin.companion
        self.remote.host, self.remote.port = '127.0.0.1', 0
        await self.remote.enable(True)
        self.tls = ssl.create_default_context(cafile=str(self.remote.directory / 'server.pem'))
        self.tls.check_hostname = False
        self.code = self.remote.begin_pairing()['pairing_code']
        status, data = await self.request('POST', '/v1/pair', {'code': self.code, 'device_name': 'Test phone'})
        self.assertEqual(status, 200, data)
        self.token = data['data']['token']

    async def request(self, method, path, body=None, token=None, extra=None):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.remote.port, ssl=self.tls)
        certificate = writer.get_extra_info('ssl_object').getpeercert(binary_form=True)
        self.assertEqual(hashlib.sha256(certificate).hexdigest(), self.remote.fingerprint)
        payload = json.dumps(body or {}).encode()
        headers = {'Host': 'localhost', 'Content-Type': 'application/json', 'Content-Length': str(len(payload))}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        headers.update(extra or {})
        wire = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items())
        writer.write(wire.encode() + b'\r\n' + payload)
        await writer.drain()
        head = (await reader.readuntil(b'\r\n\r\n')).decode()
        length = next(int(line.split(':', 1)[1]) for line in head.split('\r\n') if line.lower().startswith('content-length:'))
        result = json.loads(await reader.readexactly(length))
        writer.close()
        with contextlib.suppress(OSError):
            await writer.wait_closed()
        return int(head.split(' ')[1]), result

    async def command(self, method, args=None, session=None, request_id=None):
        return await self.request('POST', '/v1/command', {
            'method': method, 'args': args or {},
            'expected_session_id': session or self.plugin.store.session['id'],
            'request_id': request_id or uuid.uuid4().hex}, token=self.token)

    async def test_remote_requires_pairing_and_rejects_browser_origins(self):
        for path in ('/v1/state', '/v1/processes', '/v1/ping'):
            status, _ = await self.request('GET', path)
            self.assertEqual(status, 401)
        status, data = await self.request('GET', '/v1/info')
        self.assertEqual(status, 200)
        self.assertEqual(data['data']['protocol'], 1)
        self.assertNotIn('devices', data['data'])
        status, _ = await self.request('GET', '/v1/state', token=self.token, extra={'Origin': 'https://untrusted.invalid'})
        self.assertEqual(status, 403)
        status, data = await self.request('GET', '/v1/ping', token=self.token)
        self.assertTrue(data['data']['alive'])
        self.assertEqual(status, 200)

    async def test_remote_pairing_is_single_use_rate_limited_and_revocable(self):
        status, _ = await self.request('POST', '/v1/pair', {'code': self.code})
        self.assertEqual(status, 403)
        self.remote.begin_pairing()
        wrong = '000000' if self.remote.pair_code != '000000' else '000001'
        for _ in range(5):
            status, _ = await self.request('POST', '/v1/pair', {'code': wrong})
            self.assertEqual(status, 403)
        status, _ = await self.request('POST', '/v1/pair', {'code': wrong})
        self.assertEqual(status, 429)
        self.remote.revoke(self.remote.status()['devices'][0]['id'])
        status, _ = await self.request('GET', '/v1/ping', token=self.token)
        self.assertEqual(status, 401)

    async def test_remote_groups_writes_freezing_and_session_guard(self):
        status, data = await self.command('save_entries', {'name': 'Linked values', 'addresses': [
            {'address': self.addresses['int32'], 'kind': 'int32'},
            {'address': self.addresses['int32_copy'], 'kind': 'int32'}]})
        self.assertEqual(status, 200, data)
        group = data['data']['session']['groups'][0]
        entry = data['data']['session']['entries'][0]
        status, _ = await self.command('freeze_entry', {'entry_id': entry['id'], 'enabled': True})
        self.assertEqual(status, 200)
        status, data = await self.command('write_group', {'group_id': group['id'], 'value': '888'})
        self.assertEqual(status, 200, data)
        self.assertEqual(self.target_value('int32'), '888')
        self.assertEqual(self.target_value('int32_copy'), '888')
        self.assertEqual(data['data']['session']['entries'][0]['freeze_value'], '888')
        status, _ = await self.command('write_entry', {'entry_id': entry['id'], 'value': '9'}, session='previous-game-session')
        self.assertEqual(status, 409)
        self.assertEqual(self.target_value('int32'), '888')

    async def test_remote_retries_do_not_repeat_a_write_and_reject_request_id_reuse(self):
        entry_id = await self.save()
        request_id = uuid.uuid4().hex
        with patch.object(self.plugin, 'write_entry', wraps=self.plugin.write_entry) as write:
            for _ in range(2):
                status, _ = await self.command('write_entry', {'entry_id': entry_id, 'value': '44'}, request_id=request_id)
                self.assertEqual(status, 200)
            self.assertEqual(write.call_count, 1)
        status, _ = await self.command('write_entry', {'entry_id': entry_id, 'value': '55'}, request_id=request_id)
        self.assertEqual(status, 409)
        self.assertEqual(self.target_value('int32'), '44')

    async def test_remote_native_scan_and_poll_without_settings_writes(self):
        status, data = await self.command('scan', {'operator': 'equal', 'value': '1379467285', 'kind': 'auto'})
        self.assertEqual(status, 200, data)
        self.assertEqual(data['data']['scan']['progress'], 1.0)
        self.assertIn(self.addresses['int32'], [r['address'] for r in data['data']['scan']['results']])
        with patch.object(self.plugin.store, 'persist', wraps=self.plugin.store.persist) as persist:
            status, data = await self.request('GET', '/v1/state?refresh=1', token=self.token)
            self.assertEqual(status, 200)
            self.assertEqual(persist.call_count, 0)

    async def test_remote_quick_edits_share_results_without_saving_and_deduplicate(self):
        status, data = await self.command('scan', {'operator': 'equal', 'value': '1379467285', 'kind': 'auto'})
        self.assertEqual(status, 200, data)
        state = data['data']
        args = {'addresses': [{'address': self.addresses[key], 'kind': 'int32'} for key in ('int32', 'int32_copy')],
                'value': '123', 'session_id': state['session']['id'], 'scan_id': state['scan']['id']}
        request_id = uuid.uuid4().hex
        with patch.object(self.plugin, 'write_results', wraps=self.plugin.write_results) as write:
            for _ in range(2):
                status, data = await self.command('write_results', args, request_id=request_id)
                self.assertEqual(status, 200, data)
            self.assertEqual(write.call_count, 1)
        self.assertEqual(data['data']['quick_write']['total'], 2)
        self.assertEqual(self.target_value('int32'), '123')
        self.assertEqual(self.target_value('int32_copy'), '123')
        status, data = await self.request('GET', '/v1/state?refresh=1', token=self.token)
        self.assertEqual(status, 200)
        self.assertFalse(data['data']['session']['groups'])
        self.assertFalse(data['data']['session']['entries'])
        row = next(r for r in data['data']['scan']['results'] if r['address'] == self.addresses['int32'])
        self.assertEqual(row['values']['int32'], '123')
        status, _ = await self.command('write_results', dict(args, scan_id='old-scan', value='999'))
        self.assertEqual(status, 400)
        self.assertEqual(self.target_value('int32'), '123')

    async def test_remote_scan_progress_can_be_polled_while_command_is_pending(self):
        await self.plugin.scan('equal', '1379467285', 'auto')
        ready, finish = asyncio.Event(), asyncio.Event()
        async def scan(on_progress=None, **request):
            on_progress(0.42)
            ready.set()
            await finish.wait()
            return {'count': 0, 'results': []}
        with patch.object(self.plugin.worker, 'request', side_effect=scan):
            pending = asyncio.create_task(self.command('scan', {'operator': 'increased_by', 'value': '5', 'kind': 'auto'}))
            await ready.wait()
            try:
                status, data = await self.request('GET', '/v1/state', token=self.token)
                self.assertEqual(status, 200)
                self.assertTrue(data['data']['scan']['busy'])
                self.assertEqual(data['data']['scan']['progress'], 0.42)
            finally:
                finish.set()
                status, _ = await pending
                self.assertEqual(status, 200)

    async def test_remote_phone_can_only_unpair_itself(self):
        status, data = await self.request('POST', '/v1/unpair', token=self.token)
        self.assertEqual(status, 200)
        self.assertTrue(data['data']['unpaired'])
        status, _ = await self.request('GET', '/v1/ping', token=self.token)
        self.assertEqual(status, 401)

    async def test_remote_keeps_identity_and_credentials_across_restart(self):
        from companion_server import CompanionServer
        old = self.remote.fingerprint
        self.assertNotIn(self.token, self.remote.path.read_text())
        await self.remote.close()
        restored = CompanionServer(self.plugin, self.remote.directory, host='127.0.0.1', port=0)
        self.plugin.companion = self.remote = restored
        await restored.start()
        self.assertEqual(restored.fingerprint, old)
        status, _ = await self.request('GET', '/v1/ping', token=self.token)
        self.assertEqual(status, 200)


# unittest inherits test methods; keep this fixture's suite scoped to LAN tests.
for _name in dir(fixtures.Backend):
    if _name.startswith('test_') and _name not in Companion.__dict__:
        setattr(Companion, _name, None)
