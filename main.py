"""Decky API v1 backend for Value Forge."""
import asyncio
import contextlib
import json
import math
import os
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import decky
from session_core import SessionStore, pack_value, unpack_value, normalize_auto_value
from companion_server import CompanionServer, expected_session, ApiError

class Worker:
    def __init__(self):
        self.process = None

    async def request(self, on_progress=None, **request):
        if self.process is None or self.process.returncode is not None:
            environment = os.environ.copy()
            # Decky may be a PyInstaller executable. Its bundled library search
            # path must not leak into the system Python used by this worker.
            if 'LD_LIBRARY_PATH_ORIG' in environment:
                environment['LD_LIBRARY_PATH'] = environment['LD_LIBRARY_PATH_ORIG']
            elif getattr(sys, 'frozen', False):
                environment.pop('LD_LIBRARY_PATH', None)
            self.process = await asyncio.create_subprocess_exec(
                shutil.which('python3') or '/usr/bin/python3', '-u', str(Path(__file__).with_name('scanner_worker.py')),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=1024 * 1024, env=environment)
        try:
            self.process.stdin.write((json.dumps(request) + '\n').encode())
            await self.process.stdin.drain()
            deadline = asyncio.get_running_loop().time() + 180
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                line = await asyncio.wait_for(self.process.stdout.readline(), timeout=remaining)
                if not line:
                    raise RuntimeError('The scanner stopped. Saved entries are still available; start a new scan.')
                response = json.loads(line)
                if response.get('event') == 'scan_progress':
                    progress = float(response['progress'])
                    if on_progress and math.isfinite(progress):
                        on_progress(max(0.0, min(1.0, progress)))
                    continue
                if not response['ok']:
                    raise RuntimeError(response['error'])
                return response['data']
        except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError, ValueError):
            await self.close()
            raise RuntimeError('The scanner did not respond. Saved entries have been kept. Reset the scan and try again.')

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None

class Plugin:
    async def _main(self):
        self.lock = asyncio.Lock()
        self.worker = Worker()
        self.worker_identity = None
        self.store = SessionStore(Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'sessions.json')
        self.freezer = asyncio.create_task(self._freeze_loop())
        self.companion = CompanionServer(self, Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / 'companion')
        if self.companion.config['enabled']:
            await self.companion.start()

    def _check_remote_session(self):
        expected = expected_session.get()
        if expected is not None and (not self.store.session or self.store.session['id'] != expected):
            raise ApiError(409, 'The game session changed. Refresh before making another change.')

    async def companion_status(self):
        return self.companion.status()

    async def companion_enable(self, enabled):
        return await self.companion.enable(enabled)

    async def companion_pairing(self):
        return self.companion.begin_pairing()

    async def companion_revoke(self, device_id):
        return self.companion.revoke(device_id)

    async def _freeze_loop(self):
        while True:
            await asyncio.sleep(0.5)
            try:
                async with self.lock:
                    await asyncio.to_thread(self.store.tick_freezes)
            except Exception:
                decky.logger.exception('Could not update frozen entries')

    async def _call(self, function, *args):
        async with self.lock:
            self._check_remote_session()
            if function == self.store.attach and self.store.scan['busy']:
                raise ValueError('Wait for the current search before switching processes.')
            await asyncio.to_thread(function, *args)
            return self.store.state()

    async def get_processes(self):
        return await asyncio.to_thread(self.store.memory.processes)

    async def get_state(self, refresh=True, persist=True):
        async with self.lock:
            if refresh:
                await asyncio.to_thread(self.store.refresh, persist)
            return self.store.state()

    async def attach(self, pid, expected_id):
        return await self._call(self.store.attach, pid, expected_id)

    async def save_entry(self, name, address, kind):
        return await self._call(self.store.save_entry, name, address, kind)

    async def save_entries(self, name, addresses, group_id=None):
        return await self._call(self.store.save_entries, name, addresses, group_id)

    async def rename_group(self, group_id, name):
        return await self._call(self.store.rename_group, group_id, name)

    async def remove_group(self, group_id):
        return await self._call(self.store.remove_group, group_id)

    async def move_entry(self, entry_id, group_id):
        return await self._call(self.store.move_entry, entry_id, group_id)

    async def rename_entry(self, entry_id, name):
        return await self._call(self.store.rename_entry, entry_id, name)

    async def remove_entry(self, entry_id):
        return await self._call(self.store.remove_entry, entry_id)

    async def write_entry(self, entry_id, value):
        return await self._call(self.store.write_entry, entry_id, value)

    async def write_group(self, group_id, value):
        return await self._call(self.store.write_group, group_id, value)

    async def write_results(self, addresses, value, session_id, scan_id):
        return await self._call(self.store.write_results, addresses, value, session_id, scan_id)

    async def freeze_entry(self, entry_id, enabled):
        return await self._call(self.store.freeze_entry, entry_id, enabled)

    async def reset_scan(self):
        async with self.lock:
            self._check_remote_session()
            if self.store.scan['busy']:
                raise ValueError('Wait for the current search before resetting it.')
            if self.worker_identity:
                await self.worker.request(action='reset')
            self.store.reset_scan()
            return self.store.state()

    async def scan(self, operator, value, kind):
        async with self.lock:
            self._check_remote_session()
            if self.store.scan['busy']:
                raise ValueError('A search is already running.')
            self.store.require_live()
            scan = self.store.scan
            if scan['has_scan'] and kind != scan['kind']:
                raise ValueError('Reset the search before changing the value type. Saved entries will stay.')
            if not scan['has_scan'] and operator not in ('equal', 'not_equal', 'greater', 'less', 'unknown'):
                raise ValueError('Run an initial search before comparing changes.')
            if scan['has_scan'] and operator == 'unknown':
                raise ValueError('Unknown initial value starts a new search. Reset the search first.')
            no_value = operator in ('unknown', 'changed', 'unchanged', 'increased', 'decreased')
            normalized = '' if no_value else (normalize_auto_value(value) if kind == 'auto' else unpack_value(kind, pack_value(kind, value)))
            if operator in ('increased_by', 'decreased_by') and float(normalized) <= 0:
                raise ValueError('Enter a positive change amount. Use Increased by X or Decreased by X to choose the direction.')
            session_id = self.store.session['id']
            pid = self.store.session['pid']
            scan['busy'] = True
            scan['progress'] = 0.0
        # Do not hold the session lock while the native scanner works. Saved
        # values can still refresh and explicitly frozen values keep updating.
        try:
            if self.worker_identity != session_id or self.worker.process is None or self.worker.process.returncode is not None:
                if scan['has_scan']:
                    async with self.lock:
                        self.store.reset_scan()
                    raise RuntimeError('Scanner restarted. Saved entries are intact; begin a new search.')
                await self.worker.close()
                await self.worker.request(action='attach', pid=pid)
                self.worker_identity = session_id
            result = await self.worker.request(action='scan', kind=kind, operator=operator, value=normalized,
                                               on_progress=lambda progress: scan.update(progress=max(scan['progress'], progress)))
            async with self.lock:
                self.store.require_live()
                rows = [dict(row) for row in result['results']]
                # Auto may find several interpretations at one address. Read each
                # concrete type so changing the result's saved type stays accurate.
                requests = []
                for index, row in enumerate(rows):
                    row.setdefault('kind', kind)
                    row.setdefault('candidate_kinds', [row['kind']])
                    row['values'] = {}
                    requests.extend((index, candidate, dict(row, kind=candidate))
                                    for candidate in row['candidate_kinds'])
                readings = await asyncio.to_thread(self.store.memory.read_entries, self.store.session,
                                                   [request[2] for request in requests])
                for (index, candidate, _), reading in zip(requests, readings):
                    rows[index]['values'][candidate] = reading['value']
                    if candidate == rows[index]['kind']:
                        rows[index].update(value=reading['value'], error=reading['error'])
                self.store.quick_write = None
                scan.update(id=uuid.uuid4().hex, has_scan=True, kind=kind, operator=operator, input=value,
                            count=result['count'], results=rows, progress=1.0)
        except Exception:
            if self.worker.process is None or self.worker.process.returncode is not None:
                async with self.lock:
                    self.worker_identity = None
                    self.store.reset_scan()
            raise
        finally:
            async with self.lock:
                scan['busy'] = False
        return self.store.state()

    async def _unload(self):
        if hasattr(self, 'companion'):
            await self.companion.close(cancel_commands=True)
        if hasattr(self, 'freezer'):
            self.freezer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.freezer
        if hasattr(self, 'lock'):
            async with self.lock:
                self.store.stop_freezes()
                try:
                    await asyncio.to_thread(self.store.persist)
                finally:
                    await self.worker.close()
