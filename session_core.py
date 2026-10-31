"""Session-owned saved addresses, independent of Decky and scan results."""
import json
import math
import os
import pwd
import re
import struct
import shutil
import time
import uuid
from pathlib import Path

FORMATS = {'int8': 'b', 'uint8': 'B', 'int16': 'h', 'uint16': 'H',
           'int32': 'i', 'uint32': 'I', 'int64': 'q', 'uint64': 'Q',
           'float32': 'f', 'float64': 'd'}

def pack_value(kind, text):
    if kind not in FORMATS:
        raise ValueError('Choose a supported value type.')
    text = str(text).strip()
    try:
        if kind.startswith('float'):
            value = float(text)
            if not math.isfinite(value):
                raise ValueError('Enter a finite number.')
        else:
            value = int(text, 16 if re.match(r'^[+-]?0x', text, re.I) else 10)
        return struct.pack('<' + FORMATS[kind], value)
    except (ValueError, OverflowError, struct.error) as error:
        raise ValueError(f'Enter a number within the {kind} range.') from error

def normalize_auto_value(text):
    text = str(text).strip()
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', text):
        raise ValueError('Enter a number using the number pad.')
    if not any(c in text.lower() for c in '.e'):
        value = int(text, 10)
        if not -(1 << 63) <= value <= (1 << 64) - 1:
            raise ValueError('Whole numbers must fit a signed or unsigned 64-bit value.')
        return str(value)
    value = float(text)
    if not math.isfinite(value):
        raise ValueError('Enter a finite number.')
    normalized = repr(value)
    return normalized if any(c in normalized.lower() for c in '.e') else normalized + '.0'

def unpack_value(kind, data):
    value = struct.unpack('<' + FORMATS[kind], data)[0]
    if kind.startswith('float'):
        return format(value, '.9g' if kind == 'float32' else '.17g')
    return str(value)

def parse_address(text):
    if not isinstance(text, str) or not re.fullmatch(r'(?:0[xX])?[0-9a-fA-F]{1,16}', text.strip()):
        raise ValueError('Enter a hexadecimal address, such as 0x1234abcd.')
    address = int(text, 16)
    if not 0 < address < (1 << 63):
        raise ValueError('Address is outside the supported userspace range.')
    return address

class ProcessMemory:
    def __init__(self, proc_root='/proc'):
        self.proc = Path(proc_root)
        self.boot = (self.proc / 'sys/kernel/random/boot_id').read_text().strip()

    def identity(self, pid):
        pid = int(pid)
        text = (self.proc / str(pid) / 'stat').read_text()
        fields = text[text.rfind(')') + 2:].split()
        if fields[0] in ('Z', 'X', 'x'):
            raise ProcessLookupError('Game process has exited.')
        return f'{self.boot}:{pid}:{fields[19]}'

    def alive(self, session):
        try:
            return self.identity(session['pid']) == session['id']
        except (OSError, ValueError, IndexError):
            return False

    def processes(self):
        try:
            uid = pwd.getpwnam(os.environ.get('DECKY_USER', '')).pw_uid
        except KeyError:
            uid = os.getuid()
        skip = {'steam', 'steamwebhelper', 'wineserver', 'gamescope', 'Xwayland',
                'systemd', 'pipewire', 'wireplumber', 'PluginLoader'}
        rows = []
        for directory in self.proc.iterdir():
            if not directory.name.isdecimal():
                continue
            try:
                pid = int(directory.name)
                if pid in (1, os.getpid()) or directory.stat().st_uid != uid:
                    continue
                name = (directory / 'comm').read_text().strip()
                if name in skip or name.startswith(('kworker', 'decky')):
                    continue
                command = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
                if not command:
                    continue
                rows.append({'pid': pid, 'name': name, 'command': command[:240],
                             'id': self.identity(pid)})
            except (OSError, ValueError, IndexError):
                continue
        return sorted(rows, key=lambda p: ('.exe' not in p['command'].lower(), p['name'].lower(), p['pid']))

    def _open(self, session, write=False):
        if not self.alive(session):
            raise ProcessLookupError('Game not running. These entries belong to its previous session.')
        fd = os.open(self.proc / str(session['pid']) / 'mem', os.O_RDWR if write else os.O_RDONLY)
        if not self.alive(session):
            os.close(fd)
            raise ProcessLookupError('The game process changed while opening its memory.')
        return fd

    def read_entries(self, session, entries):
        results = []
        try:
            fd = self._open(session)
        except OSError as error:
            return [{'value': None, 'error': str(error)} for _ in entries]
        try:
            for entry in entries:
                try:
                    size = struct.calcsize(FORMATS[entry['kind']])
                    data = os.pread(fd, size, parse_address(entry['address']))
                    if len(data) != size:
                        raise OSError('Address is no longer readable.')
                    results.append({'value': unpack_value(entry['kind'], data), 'error': None})
                except (OSError, ValueError, struct.error) as error:
                    results.append({'value': None, 'error': str(error)})
        finally:
            os.close(fd)
        return results

    def write_entry(self, session, entry, text):
        data = pack_value(entry['kind'], text)
        address = parse_address(entry['address'])
        fd = self._open(session, write=True)
        try:
            writable = False
            for line in (self.proc / str(session['pid']) / 'maps').read_text().splitlines():
                parts = line.split()
                start, end = (int(v, 16) for v in parts[0].split('-'))
                if start <= address and address + len(data) <= end and 'w' in parts[1]:
                    writable = True
                    break
            if not writable:
                raise ValueError('Address is not in a writable memory region.')
            if os.pwrite(fd, data, address) != len(data):
                raise OSError('The game did not accept the complete value.')
        finally:
            os.close(fd)

    def write_entries(self, session, entries, text):
        """Preflight the entire group, then write through one process-memory FD.

        The game continues running: OS failures after preflight can still cause
        a partial update. Report each result rather than claiming atomicity.
        """
        prepared = []
        desired = {}
        for entry in entries:
            try:
                data = pack_value(entry['kind'], text)
                address = parse_address(entry['address'])
            except ValueError as error:
                raise ValueError(f"{entry['name']} ({entry['kind']}): {error} No addresses were changed.") from error
            for offset, byte in enumerate(data):
                if address + offset in desired and desired[address + offset] != byte:
                    raise ValueError('Selected addresses overlap with conflicting types. No addresses were changed.')
                desired[address + offset] = byte
            prepared.append((entry, address, data))
        fd = self._open(session, write=True)
        try:
            regions = []
            for line in (self.proc / str(session['pid']) / 'maps').read_text().splitlines():
                parts = line.split()
                if 'w' in parts[1]:
                    regions.append(tuple(int(value, 16) for value in parts[0].split('-')))
            for entry, address, data in prepared:
                if not any(start <= address and address + len(data) <= end for start, end in regions):
                    raise ValueError(f"{entry['name']} ({entry['address']}) is not writable. No addresses were changed.")
                try:
                    if len(os.pread(fd, len(data), address)) != len(data):
                        raise OSError('Address is no longer readable.')
                except OSError as error:
                    raise ValueError(f"{entry['name']} ({entry['address']}): {error} No addresses were changed.") from error
            written, failed = [], []
            for entry, address, data in prepared:
                try:
                    if os.pwrite(fd, data, address) != len(data):
                        raise OSError('Only part of this address could be written; refresh and inspect it.')
                    written.append(entry['id'])
                except OSError as error:
                    failed.append({'id': entry['id'], 'name': entry['name'],
                                   'address': entry['address'], 'error': str(error)})
            return written, failed
        finally:
            os.close(fd)

class SessionStore:
    def __init__(self, path, memory=None):
        self.path = Path(path)
        self.memory = memory or ProcessMemory()
        self.sessions = {}
        self.active = None
        self.storage_warning = None
        self.group_write = None
        self.quick_write = None
        self.migrated_v1 = False
        self.scan = {'id': uuid.uuid4().hex, 'kind': 'auto', 'has_scan': False, 'count': 0, 'results': [],
                     'operator': 'equal', 'input': '', 'busy': False, 'progress': 0.0}
        try:
            stored = json.loads(self.path.read_text())
            if stored.get('version') not in (1, 2) or not isinstance(stored.get('sessions'), dict):
                raise ValueError('Unrecognized session file.')
            self.sessions = stored['sessions']
            self.active = stored.get('active')
            self.migrated_v1 = stored['version'] == 1
            for session in self.sessions.values():
                if self.migrated_v1:
                    # Preserve every address and ID; merge legacy entries with
                    # matching names into a single named group.
                    session['groups'] = []
                    by_name = {}
                    for entry in session['entries']:
                        key = entry['name'].casefold()
                        if key not in by_name:
                            group = {'id': uuid.uuid4().hex, 'name': entry['name']}
                            session['groups'].append(group)
                            by_name[key] = group
                        entry['group_id'] = by_name[key]['id']
                group_ids = {group['id'] for group in session['groups']}
                if any(entry['group_id'] not in group_ids for entry in session['entries']):
                    raise ValueError('An address has no saved group.')
                for entry in session['entries']:
                    entry['frozen'] = False  # Never silently resume writing after a reload.
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError):
            self.sessions = {}
            self.active = None
            self.storage_warning = 'The saved session file could not be loaded; the original file has been kept.'

    @property
    def session(self):
        return self.sessions.get(self.active)

    def persist(self):
        if self.storage_warning:
            raise RuntimeError(self.storage_warning)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.migrated_v1 and self.path.exists():
            backup = self.path.with_name(self.path.stem + '.v1-backup.json')
            if not backup.exists():
                shutil.copy2(self.path, backup)
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('w') as out:
            json.dump({'version': 2, 'active': self.active, 'sessions': self.sessions}, out, allow_nan=False)
            out.flush()
            os.fsync(out.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, self.path)
        self.migrated_v1 = False

    def attach(self, pid, expected_id):
        pid = int(pid)
        session_id = self.memory.identity(pid)
        if session_id != expected_id:
            raise ValueError('The process changed. Reload the process list and select it again.')
        probe = {'id': session_id, 'pid': pid}
        fd = self.memory._open(probe)
        os.close(fd)
        changed = self.active != session_id
        if changed:
            self.stop_freezes()
            self.group_write = None
            name = (self.memory.proc / str(pid) / 'comm').read_text().strip()
            self.sessions.setdefault(session_id, {'id': session_id, 'pid': pid,
                                                 'name': name, 'entries': [], 'groups': []})
            self.active = session_id
            self.reset_scan()
        self.persist()
        return changed

    def reset_scan(self):
        self.quick_write = None
        self.scan.update(id=uuid.uuid4().hex, has_scan=False, count=0, results=[], operator='equal', input='', progress=0.0)

    def require_live(self):
        if self.session is None or not self.memory.alive(self.session):
            raise ProcessLookupError('Select a running game process first.')

    def refresh(self, persist=True):
        session = self.session
        if not session:
            return
        alive = self.memory.alive(session)
        entries = session['entries']
        readings = self.memory.read_entries(session, entries)
        now = time.time()
        for entry, reading in zip(entries, readings):
            previous = entry.get('last_value')
            entry.update(value=reading['value'], previous=previous,
                         changed=reading['value'] is not None and previous is not None and reading['value'] != previous,
                         status='ok' if reading['error'] is None else ('unavailable' if alive else 'exited'),
                         error=reading['error'], updated_at=now)
            if reading['value'] is not None:
                entry['last_value'] = reading['value']
            if reading['error']:
                entry['frozen'] = False
        self.refresh_results()
        if persist:
            self.persist()

    def refresh_results(self):
        """Refresh display values only; scanmem retains its comparison baseline."""
        if not self.session or self.scan['busy']:
            return
        requests = [(row, kind, {'address': row['address'], 'kind': kind})
                    for row in self.scan['results']
                    for kind in row.get('candidate_kinds', [row['kind']])]
        readings = self.memory.read_entries(self.session, [request[2] for request in requests])
        for (row, kind, _), reading in zip(requests, readings):
            row.setdefault('values', {})[kind] = reading['value']
            if kind == row['kind']:
                row.update(value=reading['value'], error=reading['error'])

    def state(self):
        session = self.session
        alive = bool(session and self.memory.alive(session))
        if not alive and session:
            for entry in session['entries']:
                entry.update(frozen=False, status='exited', value=None, changed=False)
        return {'session': session, 'alive': alive, 'scan': self.scan,
                'storage_warning': self.storage_warning, 'group_write': self.group_write,
                'quick_write': self.quick_write}

    def group(self, group_id):
        for group in self.session['groups'] if self.session else []:
            if group['id'] == group_id:
                return group
        raise ValueError('Saved group no longer exists.')

    def unique_group_name(self, name, except_id=None):
        name = self.validate_name(name)
        if any(g['id'] != except_id and g['name'].casefold() == name.casefold()
               for g in self.session['groups']):
            raise ValueError('A group already has that name. Select it to add more addresses.')
        return name

    def save_entry(self, name, address, kind, group_id=None):
        self.save_entries(name, [{'address': address, 'kind': kind}], group_id)

    def save_entries(self, name, addresses, group_id=None):
        self.require_live()
        if not isinstance(addresses, list) or not 1 <= len(addresses) <= 200:
            raise ValueError('Select between 1 and 200 addresses to save.')
        entries = self.session['entries']
        if len(entries) + len(addresses) > 200:
            raise ValueError('A session can hold up to 200 saved addresses.')
        group = self.group(group_id) if group_id else None
        if group is None:
            name = self.unique_group_name(name)
            if len(self.session['groups']) >= 200:
                raise ValueError('A session can hold up to 200 groups.')
        # Validate the whole batch before changing either the list or groups.
        seen = {(e['address'], e['kind']) for e in entries if e['group_id'] == group_id}
        normalized = []
        for candidate in addresses:
            address = hex(parse_address(candidate['address']))
            kind = candidate['kind']
            if kind not in FORMATS:
                raise ValueError('Choose a supported value type.')
            if (address, kind) in seen:
                raise ValueError('That address and type are already in this group.')
            seen.add((address, kind))
            normalized.append((address, kind))
        if group is None:
            group = {'id': uuid.uuid4().hex, 'name': name}
            self.session['groups'].append(group)
        number = sum(e['group_id'] == group['id'] for e in entries)
        for address, kind in normalized:
            number += 1
            entries.append({'id': uuid.uuid4().hex, 'group_id': group['id'],
                            'name': group['name'] if number == 1 else f'Address {number}',
                            'address': address, 'kind': kind, 'frozen': False, 'freeze_value': None,
                            'value': None, 'last_value': None, 'previous': None,
                            'changed': False, 'status': 'unavailable', 'error': None,
                            'updated_at': None})
        self.refresh()

    def rename_group(self, group_id, name):
        group = self.group(group_id)
        group['name'] = self.unique_group_name(name, except_id=group_id)
        self.persist()

    def remove_group(self, group_id):
        group = self.group(group_id)
        self.session['entries'] = [e for e in self.session['entries'] if e['group_id'] != group_id]
        self.session['groups'].remove(group)
        self.persist()

    def move_entry(self, entry_id, group_id):
        entry = self.entry(entry_id)
        self.group(group_id)
        if any(e['id'] != entry_id and e['group_id'] == group_id and
               (e['address'], e['kind']) == (entry['address'], entry['kind'])
               for e in self.session['entries']):
            raise ValueError('That address and type are already in the destination group.')
        entry['group_id'] = group_id
        self.persist()

    @staticmethod
    def validate_name(name):
        name = str(name).strip()
        if not name or len(name) > 80:
            raise ValueError('Enter a name from 1 to 80 characters.')
        return name

    def entry(self, entry_id):
        for entry in self.session['entries'] if self.session else []:
            if entry['id'] == entry_id:
                return entry
        raise ValueError('Saved entry no longer exists.')

    def rename_entry(self, entry_id, name):
        self.entry(entry_id)['name'] = self.validate_name(name)
        self.persist()

    def remove_entry(self, entry_id):
        entry = self.entry(entry_id)
        self.session['entries'].remove(entry)
        self.persist()

    def write_entry(self, entry_id, value):
        self.require_live()
        entry = self.entry(entry_id)
        self.memory.write_entry(self.session, entry, value)
        if entry['frozen']:
            entry['freeze_value'] = unpack_value(entry['kind'], pack_value(entry['kind'], value))
        self.refresh()

    def write_group(self, group_id, value):
        self.require_live()
        group = self.group(group_id)
        entries = [entry for entry in self.session['entries'] if entry['group_id'] == group_id]
        if not entries:
            raise ValueError('This group has no addresses to update.')
        written, failed = self.memory.write_entries(self.session, entries, value)
        successful = set(written)
        for entry in entries:
            if entry['id'] in successful and entry['frozen']:
                entry['freeze_value'] = unpack_value(entry['kind'], pack_value(entry['kind'], value))
            elif entry['id'] not in successful:
                entry['frozen'] = False
        self.group_write = {'group_id': group_id, 'name': group['name'], 'value': str(value),
                            'total': len(entries), 'written': written, 'failed': failed,
                            'updated_at': time.time()}
        self.refresh()

    def write_results(self, addresses, value, session_id, scan_id):
        self.require_live()
        if self.session['id'] != session_id:
            raise ValueError('The game session changed. Reopen Quick edit before applying a value.')
        if self.scan['busy']:
            raise ValueError('Wait for the current search before editing results.')
        if not self.scan['has_scan'] or self.scan['id'] != scan_id:
            raise ValueError('Search results changed. Reopen Quick edit before applying a value.')
        if not isinstance(addresses, list) or not 1 <= len(addresses) <= 200:
            raise ValueError('Select between 1 and 200 search results to edit.')
        matches = {hex(parse_address(row['address'])): row for row in self.scan['results']}
        targets, seen = [], set()
        for candidate in addresses:
            if not isinstance(candidate, dict):
                raise ValueError('Choose a valid search result and concrete type.')
            address = hex(parse_address(candidate.get('address')))
            kind = candidate.get('kind')
            row = matches.get(address)
            if not isinstance(kind, str) or kind not in FORMATS or row is None or kind not in row.get('candidate_kinds', [row['kind']]):
                raise ValueError('That address or type is no longer in these search results.')
            if address in seen:
                raise ValueError('Select each search address only once.')
            seen.add(address)
            targets.append({'id': address, 'name': address, 'address': address, 'kind': kind})
        # Use the same whole-batch range/overlap/writability preflight as groups.
        written, failed = self.memory.write_entries(self.session, targets, value)
        self.quick_write = {'session_id': session_id, 'scan_id': scan_id, 'value': str(value),
                            'addresses': [{'address': e['address'], 'kind': e['kind']} for e in targets],
                            'total': len(targets), 'written': written, 'failed': failed, 'updated_at': time.time()}
        self.refresh(persist=False)
        # A matching saved freeze must not immediately undo an explicit edit.
        # Read its actual bytes back, including any overlap with another width.
        successful = set(written)
        failed_ids = {e['id'] for e in failed}
        for entry in self.session['entries']:
            if not entry['frozen']:
                continue
            start = parse_address(entry['address'])
            end = start + struct.calcsize(FORMATS[entry['kind']])
            overlaps = {target['id'] for target in targets
                        if start < parse_address(target['address']) + struct.calcsize(FORMATS[target['kind']])
                        and parse_address(target['address']) < end}
            if overlaps & failed_ids or entry['value'] is None:
                entry['frozen'] = False
            elif overlaps & successful:
                entry['freeze_value'] = entry['value']
        self.persist()

    def freeze_entry(self, entry_id, enabled):
        entry = self.entry(entry_id)
        if enabled:
            self.require_live()
            reading = self.memory.read_entries(self.session, [entry])[0]
            if reading['error']:
                raise ValueError('This address is unavailable and cannot be frozen.')
            pack_value(entry['kind'], reading['value'])
            entry['freeze_value'] = reading['value']
        entry['frozen'] = bool(enabled)
        self.persist()

    def tick_freezes(self):
        dirty = False
        for session in self.sessions.values():
            for entry in session['entries']:
                if not entry['frozen']:
                    continue
                try:
                    self.memory.write_entry(session, entry, entry['freeze_value'])
                except (OSError, ValueError) as error:
                    entry.update(frozen=False, error=str(error), value=None,
                                 status='unavailable' if self.memory.alive(session) else 'exited')
                    dirty = True
        if dirty:
            self.persist()

    def stop_freezes(self):
        for session in self.sessions.values():
            for entry in session['entries']:
                entry['frozen'] = False
