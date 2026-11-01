"""Private LAN API for Value Forge Companion. No third-party Python packages."""
import asyncio
import contextvars
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import time
from collections import OrderedDict
from pathlib import Path
from http.cookies import SimpleCookie, CookieError
from urllib.parse import urlsplit, parse_qs

expected_session = contextvars.ContextVar('companion_session', default=None)
PROTOCOL = 1
VERSION = '0.8.0'
PORT = 52881
WEB_COOKIE = '__Host-ValueForge'
WEB_ROOT = Path(__file__).resolve().parent / 'web'
WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"


class WebResponse:
    def __init__(self, body, content_type='application/json', headers=None):
        self.body = body if isinstance(body, bytes) else json.dumps({'ok': True, 'data': body}, allow_nan=False).encode()
        self.content_type = content_type
        self.headers = headers or {}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def clean_environment():
    env = os.environ.copy()
    if 'LD_LIBRARY_PATH_ORIG' in env:
        env['LD_LIBRARY_PATH'] = env['LD_LIBRARY_PATH_ORIG']
    else:
        env.pop('LD_LIBRARY_PATH', None)
    return env


class CompanionServer:
    def __init__(self, plugin, directory, host='0.0.0.0', port=PORT):
        self.plugin, self.directory = plugin, Path(directory)
        self.host, self.port = host, port
        self.path = self.directory / 'companion.json'
        self.server = None
        self.error = None
        self.storage_error = False
        self.fingerprint = ''
        self.pair_code, self.pair_deadline, self.pair_attempts = '', 0, 0
        self.handlers = set()
        self.commands = OrderedDict()
        self.command_lock = asyncio.Lock()
        self.last_seen = {}
        self.config = {'enabled': False, 'server_id': secrets.token_hex(16), 'devices': {}}
        try:
            self.config = json.loads(self.path.read_text())
            assert isinstance(self.config['enabled'], bool)
            assert len(self.config['server_id']) == 32
            assert isinstance(self.config['devices'], dict) and len(self.config['devices']) <= 8
            for digest, device in self.config['devices'].items():
                assert len(digest) == 64 and isinstance(device['id'], str) and isinstance(device['name'], str)
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AssertionError):
            self.storage_error = True
            self.config = {'enabled': False, 'server_id': '', 'devices': {}}
            self.error = 'Companion settings could not be read. The original file has been preserved.'

    def persist(self):
        if self.storage_error:
            raise ValueError(self.error)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = self.path.with_suffix('.tmp')
        with temp.open('w') as out:
            os.chmod(temp, 0o600)
            json.dump(self.config, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, self.path)

    def certificate(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        cert, key = self.directory / 'server.pem', self.directory / 'server.key'
        if cert.exists() != key.exists():
            raise ValueError('The companion certificate is incomplete. Restore its settings before pairing.')
        if not cert.exists():
            if self.config['devices']:
                raise ValueError('The paired certificate is missing. Restore it before reconnecting.')
            openssl = shutil.which('openssl')
            if not openssl:
                raise ValueError('OpenSSL is required to enable the companion connection.')
            with key.open('w') as out:
                os.chmod(key, 0o600)
            try:
                subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
                                '-days', '3650', '-subj', '/CN=Value Forge Companion',
                                '-keyout', str(key), '-out', str(cert)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=30, env=clean_environment())
            except Exception:
                key.unlink(missing_ok=True)
                cert.unlink(missing_ok=True)
                raise ValueError('Could not create the companion certificate.')
        os.chmod(key, 0o600)
        self.fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        return context

    async def start(self):
        if self.server:
            return
        try:
            if self.storage_error:
                raise ValueError(self.error)
            context = await asyncio.to_thread(self.certificate)
            self.server = await asyncio.start_server(self.handle, self.host, self.port,
                                                    ssl=context, limit=131072,
                                                    ssl_handshake_timeout=8)
            self.port = self.server.sockets[0].getsockname()[1]
            self.error = None
        except Exception as error:
            self.error = str(error)

    async def enable(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError('Choose whether to enable the companion connection.')
        if enabled:
            await self.start()
            if not self.server:
                raise ValueError(self.error)
        else:
            await self.close()
        self.config['enabled'] = enabled
        self.persist()
        return self.status()

    async def close(self, cancel_commands=False):
        self.pair_code = ''
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        tasks = list(self.handlers)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if cancel_commands:
            jobs = [item[1] for item in self.commands.values() if not item[1].done()]
            for job in jobs:
                job.cancel()
            if jobs:
                await asyncio.gather(*jobs, return_exceptions=True)

    def status(self):
        addresses = []
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect(('192.0.2.1', 9))  # Routing lookup only; no packets are sent.
                address = probe.getsockname()[0]
                if not address.startswith('127.'):
                    addresses.append(f'{address}:{self.port}')
        except OSError:
            pass
        hostname = socket.gethostname()
        hostname = hostname if hostname.endswith('.local') else hostname + '.local'
        return {'enabled': self.config['enabled'], 'listening': bool(self.server), 'error': self.error,
                'port': self.port, 'addresses': addresses, 'hostname': f'{hostname}:{self.port}',
                'web_urls': [f'https://{address}/' for address in addresses] + [f'https://{hostname}:{self.port}/'],
                'fingerprint': self.fingerprint, 'server_id': self.config['server_id'],
                'pairing_code': self.pair_code if time.monotonic() < self.pair_deadline else '',
                'expires_in': max(0, int(self.pair_deadline - time.monotonic())) if self.pair_code else 0,
                'devices': [dict(device, last_seen=self.last_seen.get(device['id']))
                            for device in self.config['devices'].values()]}

    def begin_pairing(self):
        if not self.server:
            raise ValueError('Enable the companion connection first.')
        if len(self.config['devices']) >= 8:
            raise ValueError('Remove a paired device before adding another phone or browser.')
        self.pair_code = f'{secrets.randbelow(1000000):06d}'
        self.pair_deadline, self.pair_attempts = time.monotonic() + 300, 0
        return self.status()

    def revoke(self, device_id):
        self.config['devices'] = {key: value for key, value in self.config['devices'].items()
                                  if value['id'] != device_id}
        self.persist()
        return self.status()

    def pair(self, data):
        if not self.pair_code or time.monotonic() >= self.pair_deadline:
            raise ApiError(403, 'Create a new pairing code in the Decky plugin.')
        self.pair_attempts += 1
        if self.pair_attempts > 5:
            self.pair_code = ''
            raise ApiError(429, 'Too many attempts. Create a new pairing code in Decky.')
        if not hmac.compare_digest(str(data.get('code', '')), self.pair_code):
            raise ApiError(403, 'The pairing code is incorrect.')
        name = data.get('device_name', 'Android phone')
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ApiError(400, 'Enter a valid device name.')
        token, device_id = secrets.token_urlsafe(32), secrets.token_hex(16)
        self.config['devices'][hashlib.sha256(token.encode()).hexdigest()] = {
            'id': device_id, 'name': name.strip(), 'paired_at': time.time()}
        self.pair_code = ''
        self.persist()
        return {'token': token, 'device_id': device_id, 'server_id': self.config['server_id'],
                'protocol': PROTOCOL, 'version': VERSION}

    def authenticate(self, headers):
        auth = headers.get('authorization', '')
        if not auth.startswith('Bearer ') or len(auth) > 256:
            raise ApiError(401, 'Pair this phone with the Decky plugin.')
        digest = hashlib.sha256(auth[7:].encode()).hexdigest()
        device = self.config['devices'].get(digest)
        if not device:
            raise ApiError(401, 'This phone is no longer paired. Pair it again in Decky.')
        self.last_seen[device['id']] = time.time()
        return device

    async def dispatch(self, device, data):
        methods = {'attach': self.plugin.attach, 'scan': self.plugin.scan,
                   'reset_scan': self.plugin.reset_scan, 'save_entries': self.plugin.save_entries,
                   'rename_group': self.plugin.rename_group, 'remove_group': self.plugin.remove_group,
                   'move_entry': self.plugin.move_entry, 'rename_entry': self.plugin.rename_entry,
                   'remove_entry': self.plugin.remove_entry, 'write_entry': self.plugin.write_entry,
                   'write_group': self.plugin.write_group, 'write_results': self.plugin.write_results,
                   'freeze_entry': self.plugin.freeze_entry}
        method, args, request_id = data.get('method'), data.get('args', {}), data.get('request_id')
        if not isinstance(method, str) or method not in methods or not isinstance(args, dict):
            raise ApiError(400, 'Unsupported companion command.')
        if not isinstance(request_id, str) or not 8 <= len(request_id) <= 80:
            raise ApiError(400, 'A unique request ID is required.')
        session_id = data.get('expected_session_id')
        if method != 'attach' and (not isinstance(session_id, str) or not session_id):
            raise ApiError(409, 'Refresh and select a running game session first.')
        signature = json.dumps([method, args, session_id], sort_keys=True)
        key = (device['id'], request_id)
        if key in self.commands:
            prior, job = self.commands[key]
            if prior != signature:
                raise ApiError(409, 'This request ID was already used for another command.')
        else:
            while len(self.commands) >= 128:
                finished = next((k for k, (_, job) in self.commands.items() if job.done()), None)
                if finished is None:
                    raise ApiError(503, 'Too many pending commands. Wait and refresh.')
                self.commands.pop(finished)
            async def execute():
                async with self.command_lock:
                    # Recheck revocation after waiting for another command.
                    if not any(d['id'] == device['id'] for d in self.config['devices'].values()):
                        raise ApiError(401, 'This phone is no longer paired.')
                    context = expected_session.set(session_id if method != 'attach' else None)
                    try:
                        result = await methods[method](**args)
                        return json.loads(json.dumps(result, allow_nan=False))
                    finally:
                        expected_session.reset(context)
            job = asyncio.create_task(execute())
            # Retrieve exceptions even when the phone disconnects mid-command.
            job.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            self.commands[key] = (signature, job)
        return await asyncio.shield(job)

    async def route(self, method, url, headers, data):
        if 'origin' in headers:
            raise ApiError(403, 'Use the paired native companion app.')
        path = urlsplit(url).path
        if method == 'GET' and path == '/v1/info':
            return {'name': 'Value Forge', 'protocol': PROTOCOL, 'version': VERSION,
                    'server_id': self.config['server_id']}
        if method == 'POST' and path == '/v1/pair':
            return self.pair(data)
        device = self.authenticate(headers)
        if method == 'GET' and path == '/v1/ping':
            return {'alive': True, 'server_id': self.config['server_id'], 'protocol': PROTOCOL}
        if method == 'POST' and path == '/v1/unpair':
            self.revoke(device['id'])
            return {'unpaired': True}
        if method == 'GET' and path == '/v1/state':
            refresh = parse_qs(urlsplit(url).query).get('refresh') == ['1']
            return await self.plugin.get_state(refresh, persist=False)
        if method == 'GET' and path == '/v1/processes':
            return await self.plugin.get_processes()
        if method == 'POST' and path == '/v1/command':
            return await self.dispatch(device, data)
        raise ApiError(404, 'Unknown companion endpoint.')

    @staticmethod
    def local_address(address):
        """Accept LAN/loopback sources, rather than all of ipaddress.is_private."""
        try:
            ip = ipaddress.ip_address(address.split('%')[0])
            ip = getattr(ip, 'ipv4_mapped', None) or ip
            networks = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
                        '169.254.0.0/16') if ip.version == 4 else ('fc00::/7', 'fe80::/10', '::1/128')
            return any(ip in ipaddress.ip_network(network) for network in networks)
        except (ValueError, AttributeError):
            return False

    def check_web_request(self, method, url, headers, peer, local):
        if not peer or not self.local_address(peer[0]):
            raise ApiError(403, 'The web companion is available only on your local network.')
        host = headers.get('host', '')
        # Only this machine's names or the address that accepted the connection.
        # Never resolve arbitrary Host names: that would permit DNS rebinding.
        if not host or any(c in host for c in '/\\@#?') or any(c.isspace() for c in host):
            raise ApiError(403, 'Open the local web address shown in Decky.')
        try:
            authority = urlsplit('https://' + host)
            hostname = socket.gethostname().lower().removesuffix('.local')
            valid = authority.hostname in {hostname, hostname + '.local', 'localhost'}
            if not valid:
                valid = (local is not None and self.local_address(authority.hostname)
                         and ipaddress.ip_address(authority.hostname) == ipaddress.ip_address(local[0]))
            if not valid or (authority.port or 443) != self.port:
                raise ValueError('Unexpected host')
        except (ValueError, TypeError):
            raise ApiError(403, 'Open the local web address shown in Decky.')
        parsed = urlsplit(url)
        if not url.startswith('/') or parsed.scheme or parsed.netloc or parsed.fragment:
            raise ApiError(400, 'A local request path is required.')
        if 'origin' in headers and headers['origin'].lower() != 'https://' + host.lower():
            raise ApiError(403, 'Use this machine’s own web companion page.')
        if parsed.path.startswith('/web-api/'):
            if headers.get('x-value-forge-web') != '1' or headers.get('sec-fetch-site', 'same-origin') != 'same-origin':
                raise ApiError(403, 'Open the web companion on this machine.')
            if method == 'POST' and 'origin' not in headers:
                raise ApiError(403, 'A same-origin browser request is required.')

    @staticmethod
    def web_cookie(token='', forget=False):
        return f'{WEB_COOKIE}={token}; Path=/; Max-Age={0 if forget else 31536000}; Secure; HttpOnly; SameSite=Strict'

    def web_device(self, headers):
        cookies = SimpleCookie()
        try:
            cookies.load(headers.get('cookie', ''))
        except CookieError:
            raise ApiError(401, 'Pair this browser with the Decky plugin.')
        token = cookies[WEB_COOKIE].value if WEB_COOKIE in cookies else ''
        try:
            return self.authenticate({'authorization': 'Bearer ' + token})
        except ApiError:
            raise ApiError(401, 'Pair this browser with the Decky plugin.')

    async def web_route(self, method, url, headers, data, peer, local):
        self.check_web_request(method, url, headers, peer, local)
        path = urlsplit(url).path
        assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                  '/index.html': ('index.html', 'text/html; charset=utf-8'),
                  '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                  '/browser-bridge.js': ('browser-bridge.js', 'text/javascript; charset=utf-8'),
                  '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if method == 'GET' and path in assets:
            name, kind = assets[path]
            return WebResponse((WEB_ROOT / name).read_bytes(), kind)
        settings = {'paired': False, 'endpoint': headers['host'], 'network_permission': True}
        if method == 'GET' and path == '/web-api/settings':
            try:
                self.web_device(headers)
                return WebResponse(dict(settings, paired=True))
            except ApiError:
                return WebResponse(settings, headers={'Set-Cookie': self.web_cookie(forget=True)})
        if method == 'POST' and path == '/web-api/pair':
            paired = self.pair(data)
            # The browser manages the credential. Never expose it to JavaScript.
            return WebResponse(dict(settings, paired=True), headers={'Set-Cookie': self.web_cookie(paired['token'])})
        if not path.startswith('/web-api/'):
            raise ApiError(404, 'Unknown web companion page.')
        device = self.web_device(headers)
        if method == 'POST' and path == '/web-api/unpair':
            self.revoke(device['id'])
            return WebResponse(settings, headers={'Set-Cookie': self.web_cookie(forget=True)})
        if method == 'GET' and path == '/web-api/ping':
            return WebResponse({'alive': True, 'server_id': self.config['server_id'], 'protocol': PROTOCOL})
        if method == 'GET' and path == '/web-api/state':
            refresh = parse_qs(urlsplit(url).query).get('refresh') == ['1']
            return WebResponse(await self.plugin.get_state(refresh, persist=False))
        if method == 'GET' and path == '/web-api/processes':
            return WebResponse({'processes': await self.plugin.get_processes()})
        if method == 'POST' and path == '/web-api/command':
            return WebResponse(await self.dispatch(device, data))
        raise ApiError(404, 'Unknown web companion endpoint.')

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        status, result = 200, None
        try:
            if len(self.handlers) > 32:
                raise ApiError(503, 'Too many connections.')
            raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
            if len(raw) > 16384:
                raise ApiError(413, 'Request headers are too large.')
            lines = raw.decode('ascii').split('\r\n')
            method, url, version = lines[0].split(' ')
            headers = {}
            for line in lines[1:]:
                if line:
                    key, value = line.split(':', 1)
                    key = key.strip().lower()
                    if key in headers:
                        raise ApiError(400, 'Duplicate headers are not supported.')
                    headers[key] = value.strip()
            if version != 'HTTP/1.1' or method not in ('GET', 'POST') or 'transfer-encoding' in headers:
                raise ApiError(400, 'Unsupported HTTP request.')
            length = int(headers.get('content-length', '0'))
            if not 0 <= length <= 131072:
                raise ApiError(413, 'Request body is too large.')
            if method == 'POST' and headers.get('content-type', '').split(';')[0] != 'application/json':
                raise ApiError(400, 'JSON is required.')
            body = await asyncio.wait_for(reader.readexactly(length), 10) if length else b'{}'
            data = json.loads(body)
            if not isinstance(data, dict):
                raise ApiError(400, 'A JSON object is required.')
            if urlsplit(url).path.startswith('/v1/'):
                result = {'ok': True, 'data': await self.route(method, url, headers, data)}
            else:
                result = await self.web_route(method, url, headers, data,
                                              writer.get_extra_info('peername'), writer.get_extra_info('sockname'))
        except asyncio.CancelledError:
            raise
        except (ValueError, TypeError, LookupError, ApiError, asyncio.TimeoutError,
                asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            status = error.status if isinstance(error, ApiError) else 400
            result = {'ok': False, 'error': str(error) or 'The request could not be read.'}
        except Exception:
            status, result = 500, {'ok': False, 'error': 'The command failed. Refresh the plugin state and try again.'}
        finally:
            try:
                if result is not None:
                    body = result.body if isinstance(result, WebResponse) else json.dumps(result, allow_nan=False).encode()
                    kind = result.content_type if isinstance(result, WebResponse) else 'application/json'
                    extra = result.headers if isinstance(result, WebResponse) else {}
                    response_headers = {'Content-Type': kind, 'Content-Length': str(len(body)),
                                        'Connection': 'close', 'Cache-Control': 'no-store',
                                        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
                                        'Content-Security-Policy': WEB_CSP, 'Referrer-Policy': 'no-referrer', **extra}
                    head = f'HTTP/1.1 {status} Response\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in response_headers.items())
                    writer.write(head.encode() + b'\r\n' + body)
                    await writer.drain()
            except (OSError, asyncio.CancelledError):
                pass
            writer.close()
            self.handlers.discard(task)
