"""Browser routes over real TLS, using the same opt-in target process as Decky."""
import asyncio
import contextlib
import hashlib
import json
import ssl
import uuid
from unittest.mock import patch
import test_session as fixtures
from companion_server import ApiError, CompanionServer, WEB_COOKIE


class WebCompanion(fixtures.Backend):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.remote = self.plugin.companion
        self.remote.host, self.remote.port = '127.0.0.1', 0
        await self.remote.enable(True)
        self.tls = ssl.create_default_context(cafile=str(self.remote.directory / 'server.pem'))
        self.tls.check_hostname = False
        self.cookie = ''

    async def request(self, method, path, data=None, extra=None):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.remote.port, ssl=self.tls)
        body = json.dumps(data or {}).encode()
        host = f'127.0.0.1:{self.remote.port}'
        headers = {'Host': host, 'Content-Type': 'application/json', 'Content-Length': str(len(body)),
                   'X-Value-Forge-Web': '1', 'Sec-Fetch-Site': 'same-origin', 'Cookie': self.cookie}
        if method == 'POST':
            headers['Origin'] = 'https://' + host
        for key, value in (extra or {}).items():
            if value is None:
                headers.pop(key, None)
            else:
                headers[key] = value
        head = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items())
        writer.write(head.encode() + b'\r\n' + body)
        await writer.drain()
        lines = (await reader.readuntil(b'\r\n\r\n')).decode().split('\r\n')
        response_headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip() for line in lines[1:] if ':' in line}
        body = await reader.readexactly(int(response_headers['content-length']))
        writer.close()
        with contextlib.suppress(OSError):
            await writer.wait_closed()
        result = json.loads(body) if response_headers['content-type'] == 'application/json' else body.decode()
        return int(lines[0].split(' ')[1]), result, response_headers

    async def pair_browser(self):
        code = self.remote.begin_pairing()['pairing_code']
        status, result, headers = await self.request('POST', '/web-api/pair', {'code': code, 'device_name': 'Test browser'})
        self.assertEqual(status, 200, result)
        self.cookie = headers['set-cookie'].split(';')[0]
        return result, headers

    async def command(self, method, args=None, session=None, request_id=None):
        return await self.request('POST', '/web-api/command', {
            'method': method, 'args': args or {}, 'request_id': request_id or uuid.uuid4().hex,
            'expected_session_id': session or self.plugin.store.session['id']})

    async def test_web_shell_and_all_assets_are_local_and_do_not_expose_state(self):
        for path, kind in [('/', 'text/html'), ('/index.html', 'text/html'), ('/app.js', 'text/javascript'),
                           ('/browser-bridge.js', 'text/javascript'), ('/style.css', 'text/css')]:
            status, body, headers = await self.request('GET', path, extra={'X-Value-Forge-Web': None})
            self.assertEqual(status, 200, path)
            self.assertTrue(headers['content-type'].startswith(kind))
            self.assertEqual(headers['cache-control'], 'no-store')
            self.assertEqual(headers['x-frame-options'], 'DENY')
            self.assertIn("connect-src 'self'", headers['content-security-policy'])
            self.assertNotIn('access-control-allow-origin', headers)
            if kind == 'text/html':
                self.assertIn('browser-bridge.js', body)
                self.assertNotIn('https://', body)
        status, data, _ = await self.request('GET', '/web-api/settings')
        self.assertEqual(status, 200)
        self.assertFalse(data['data']['paired'])
        for path in ('/web-api/state', '/web-api/processes', '/web-api/ping'):
            status, _, _ = await self.request('GET', path)
            self.assertEqual(status, 401)
        for path in ('/companion.json', '/server.key', '/../main.py', '/%2e%2e/main.py', '/web-api/unknown'):
            status, _, _ = await self.request('GET', path)
            self.assertIn(status, (401, 404))

    async def test_web_pairs_with_httponly_cookie_and_remembers_across_restart(self):
        result, headers = await self.pair_browser()
        self.assertTrue(result['data']['paired'])
        self.assertNotIn('token', result['data'])
        cookie = headers['set-cookie']
        for flag in ('Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=31536000'):
            self.assertIn(flag, cookie)
        token = self.cookie.split('=', 1)[1]
        self.assertNotIn(token, self.remote.path.read_text())
        self.assertIn(hashlib.sha256(token.encode()).hexdigest(), self.remote.config['devices'])
        previous_fingerprint = self.remote.fingerprint
        await self.remote.close()
        restored = CompanionServer(self.plugin, self.remote.directory, host='127.0.0.1', port=0)
        self.plugin.companion = self.remote = restored
        await restored.start()
        self.assertEqual(restored.fingerprint, previous_fingerprint)
        status, result, _ = await self.request('GET', '/web-api/settings')
        self.assertEqual(status, 200)
        self.assertTrue(result['data']['paired'])
        status, result, _ = await self.request('GET', '/web-api/state?refresh=1')
        self.assertEqual(status, 200)
        self.assertEqual(result['data']['session']['id'], self.plugin.store.session['id'])

    async def test_web_rejects_other_origins_forms_and_rebinding_without_consuming_code(self):
        code = self.remote.begin_pairing()['pairing_code']
        bad = [{'Origin': 'https://evil.invalid'}, {'Origin': None}, {'Origin': 'null'},
               {'X-Value-Forge-Web': None}, {'Sec-Fetch-Site': 'cross-site'},
               {'Content-Type': 'text/plain'}, {'Host': f'evil.invalid:{self.remote.port}'},
               {'Host': '127.0.0.1:123'}, {'Host': f'192.168.1.4:{self.remote.port}'}]
        for headers in bad:
            status, _, _ = await self.request('POST', '/web-api/pair', {'code': code}, extra=headers)
            self.assertIn(status, (400, 403), headers)
            self.assertEqual(self.remote.pair_code, code)
            self.assertFalse(self.remote.config['devices'])
        for address in ('8.8.8.8', '100.64.0.1', '203.0.113.1', '::', '2001:4860:4860::8888', '::ffff:8.8.8.8'):
            self.assertFalse(self.remote.local_address(address))
            with self.assertRaises(ApiError):
                self.remote.check_web_request('GET', '/', {}, (address, 1), ('127.0.0.1', self.remote.port))
        for address in ('127.0.0.1', '192.168.2.1', '10.1.2.3', '172.16.1.1', '169.254.1.1', 'fd00::1', '::1', '::ffff:192.168.1.3'):
            self.assertTrue(self.remote.local_address(address), address)
        status, _, _ = await self.request('GET', '/', extra={'Host': f'evil.invalid:{self.remote.port}'})
        self.assertEqual(status, 403)

    async def test_web_revocation_and_forget_leave_other_devices_paired(self):
        code = self.remote.begin_pairing()['pairing_code']
        status, native, _ = await self.request('POST', '/v1/pair', {'code': code}, extra={'Origin': None})
        self.assertEqual(status, 200)
        await self.pair_browser()
        browser = next(d for d in self.remote.config['devices'].values() if d['name'] == 'Test browser')
        self.remote.revoke(browser['id'])
        status, _, _ = await self.request('GET', '/web-api/state')
        self.assertEqual(status, 401)
        status, result, headers = await self.request('GET', '/web-api/settings')
        self.assertFalse(result['data']['paired'])
        self.assertIn('Max-Age=0', headers['set-cookie'])
        await self.pair_browser()
        status, result, headers = await self.request('POST', '/web-api/unpair')
        self.assertEqual(status, 200)
        self.assertFalse(result['data']['paired'])
        self.assertIn('Max-Age=0', headers['set-cookie'])
        status, _, _ = await self.request('GET', '/v1/ping', extra={'Authorization': 'Bearer ' + native['data']['token']})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.remote.config['devices']), 1)

    async def test_web_uses_shared_groups_individual_edits_freeze_and_result_quick_edits(self):
        await self.pair_browser()
        status, result, _ = await self.command('save_entries', {'name': 'Linked', 'addresses': [
            {'address': self.addresses[key], 'kind': 'int32'} for key in ('int32', 'int32_copy')]})
        self.assertEqual(status, 200, result)
        group = result['data']['session']['groups'][0]
        entry = result['data']['session']['entries'][0]
        status, _, _ = await self.command('freeze_entry', {'entry_id': entry['id'], 'enabled': True})
        self.assertEqual(status, 200)
        status, result, _ = await self.command('write_group', {'group_id': group['id'], 'value': '1379467001'})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.target_value('int32'), '1379467001')
        self.assertEqual(self.target_value('int32_copy'), '1379467001')
        self.assertEqual(result['data']['session']['entries'][0]['freeze_value'], '1379467001')
        await self.command('freeze_entry', {'entry_id': entry['id'], 'enabled': False})
        await self.command('write_entry', {'entry_id': entry['id'], 'value': '999'})
        self.assertEqual(self.target_value('int32_copy'), '1379467001')
        status, result, _ = await self.command('scan', {'operator': 'equal', 'value': '1379467001', 'kind': 'auto'})
        self.assertEqual(status, 200, result)
        scan = result['data']['scan']
        status, result, _ = await self.command('write_results', {'addresses': [{'address': self.addresses['int32_copy'], 'kind': 'int32'}],
            'value': '123', 'session_id': self.plugin.store.session['id'], 'scan_id': scan['id']})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['data']['quick_write']['total'], 1)
        self.assertEqual(len(result['data']['session']['entries']), 2)
        self.assertEqual(self.target_value('int32_copy'), '123')
        status, result, _ = await self.request('GET', '/web-api/processes')
        self.assertEqual(status, 200)
        self.assertIsInstance(result['data']['processes'], list)
        with patch.object(self.plugin.store, 'persist', wraps=self.plugin.store.persist) as persist:
            status, result, _ = await self.request('GET', '/web-api/state?refresh=1')
            self.assertEqual(status, 200)
            self.assertEqual(persist.call_count, 0)
        self.assertEqual(result['data']['session']['entries'][1]['value'], '123')

    async def test_web_scan_progress_remains_readable_during_a_search(self):
        await self.pair_browser()
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
                status, result, _ = await self.request('GET', '/web-api/state')
                self.assertEqual(status, 200)
                self.assertTrue(result['data']['scan']['busy'])
                self.assertEqual(result['data']['scan']['progress'], 0.42)
            finally:
                finish.set()
                status, _, _ = await pending
                self.assertEqual(status, 200)

    async def test_web_commands_keep_native_session_and_duplicate_request_guards(self):
        await self.pair_browser()
        entry_id = await self.save()
        request_id = uuid.uuid4().hex
        with patch.object(self.plugin, 'write_entry', wraps=self.plugin.write_entry) as write:
            for _ in range(2):
                status, _, _ = await self.command('write_entry', {'entry_id': entry_id, 'value': '44'}, request_id=request_id)
                self.assertEqual(status, 200)
            self.assertEqual(write.call_count, 1)
        status, _, _ = await self.command('write_entry', {'entry_id': entry_id, 'value': '55'}, request_id=request_id)
        self.assertEqual(status, 409)
        status, _, _ = await self.command('write_entry', {'entry_id': entry_id, 'value': '99'}, session='previous-game')
        self.assertEqual(status, 409)
        self.assertEqual(self.target_value('int32'), '44')


for _name in dir(fixtures.Backend):
    if _name.startswith('test_') and _name not in WebCompanion.__dict__:
        setattr(WebCompanion, _name, None)
