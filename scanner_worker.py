"""Private JSON-lines worker. The native scanner never runs inside Decky.

Uses the public libscanmem command API, as in scanmem's GameConqueror wrapper.
Its stdout capture and match format are derived from that GPL-3.0-or-later
wrapper (Wang Lu, Sebastian Parschauer, Andrea Stacchiotti); see THIRD_PARTY.md.
"""
import ctypes
import json
import os
import re
import sys
import tempfile
import threading
import math
from pathlib import Path

MATCH = re.compile(r'^\[\s*(\d+)\]\s+([\da-f]+),\s+\d+\s+\+\s+[\da-f]+,\s+\w+,\s+(.*),\s+\[([\w ]+)\]$', re.I)
TYPES = {'auto': 'int', 'int8': 'int8', 'uint8': 'int8', 'int16': 'int16', 'uint16': 'int16',
         'int32': 'int32', 'uint32': 'int32', 'int64': 'int64', 'uint64': 'int64',
         'float32': 'float32', 'float64': 'float64'}

class Scanner:
    def __init__(self):
        self.lib = ctypes.CDLL(str(Path(__file__).parent / 'bin' / 'libscanmem.so.1.0.0'))
        for name, result, args in [
            ('sm_init', ctypes.c_bool, []), ('sm_cleanup', None, []),
            ('sm_set_backend', None, []),
            ('sm_backend_exec_cmd', None, [ctypes.c_char_p]),
            ('sm_get_num_matches', ctypes.c_ulong, []),
            ('sm_get_scan_progress', ctypes.c_double, []),
        ]:
            f = getattr(self.lib, name)
            f.restype, f.argtypes = result, args
        self.lib.sm_set_backend()
        if not self.lib.sm_init():
            raise RuntimeError('Unable to initialize the memory scanner.')
        # Root can open /proc/PID/mem directly. Avoid stopping a game's thread
        # during scans, and avoid leaving a tracee stopped if the worker dies.
        self.command('option noptrace 1')
        self.command('option region_scan_level 3')
        self.pid = None
        self.auto_family = None

    def command(self, command):
        # Capture only in this isolated, single-threaded worker. Native printf
        # must not contaminate the JSON protocol or Decky's own stdout.
        sys.stdout.flush()
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            saved_out, saved_err = os.dup(1), os.dup(2)
            try:
                os.dup2(output.fileno(), 1)
                os.dup2(errors.fileno(), 2)
                self.lib.sm_backend_exec_cmd(command.encode('ascii'))
            finally:
                os.dup2(saved_out, 1)
                os.dup2(saved_err, 2)
                os.close(saved_out)
                os.close(saved_err)
            output.seek(0)
            errors.seek(0)
            text, diagnostics = output.read().decode(), errors.read().decode()
        if 'error:' in diagnostics.lower():
            raise RuntimeError(diagnostics.strip()[-1200:])
        return text

    def handle(self, request):
        action = request['action']
        if action == 'attach':
            pid = int(request['pid'])
            if self.pid != pid:
                self.command(f'pid {pid}')
                self.pid = pid
                self.auto_family = None
            return {}
        if action == 'reset':
            self.command('reset')
            self.auto_family = None
            return {}
        if action == 'scan':
            kind = request['kind']
            if kind not in TYPES:
                raise ValueError('Unsupported value type.')
            operator = request['operator']
            commands = {'equal': '=', 'not_equal': '!=', 'greater': '>', 'less': '<',
                        'changed': '!=', 'unchanged': '=', 'increased': '+',
                        'decreased': '-', 'increased_by': '+', 'decreased_by': '-',
                        'unknown': 'snapshot'}
            if operator not in commands:
                raise ValueError('Unsupported comparison.')
            value = request.get('value', '')
            if value and not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', value):
                raise ValueError('Invalid search value.')
            delta = operator in ('increased_by', 'decreased_by')
            if delta and (not value or not math.isfinite(float(value)) or float(value) <= 0):
                raise ValueError('Enter a positive change amount.')
            if kind == 'auto':
                if self.auto_family is None:
                    self.auto_family = 'number' if operator == 'unknown' else (
                        'float' if any(c in value.lower() for c in '.e') else 'int')
                elif self.auto_family == 'number' and value:
                    # A broad snapshot contains all kinds. When the first known
                    # value arrives, narrow its family before comparing. Scanmem's
                    # ANYNUMBER parser also sets truncated integer interpretations
                    # for decimal input, which otherwise creates false positives.
                    # A whole-number difference also applies to floating-point
                    # values (e.g. 12.5 -> 17.5). Keep both families after an
                    # unknown snapshot until a known total or decimal delta
                    # actually narrows the family.
                    if not delta or any(c in value.lower() for c in '.e'):
                        self.auto_family = 'float' if any(c in value.lower() for c in '.e') else 'int'
                if self.auto_family == 'int' and value and any(c in value.lower() for c in '.e'):
                    number = float(value)
                    if not number.is_integer():
                        raise ValueError('This Auto search started with whole numbers. Reset it before searching decimal values.')
                    value = str(int(number))
                scan_type = self.auto_family
            else:
                scan_type = TYPES[kind]
            self.command('option scan_data_type ' + scan_type)
            self.command(commands[operator] + (' ' + value if value else ''))
            count = int(self.lib.sm_get_num_matches())
            rows = []
            if count:
                for line in self.command('list 200').splitlines():
                    match = MATCH.match(line.strip())
                    if not match:
                        raise RuntimeError('The scanner returned an unrecognized result format.')
                    candidates = []
                    for token in match.group(4).split():
                        if token in ('F32', 'F64'):
                            candidates.append('float' + token[1:])
                        else:
                            integer = re.fullmatch(r'I(8|16|32|64)([us]?)', token)
                            if integer:
                                bits, sign = integer.groups()
                                if sign != 'u':
                                    candidates.append('int' + bits)
                                if sign != 's':
                                    candidates.append('uint' + bits)
                    if kind != 'auto':
                        candidates = [kind]
                    priority = ['int32', 'uint32', 'float32', 'float64', 'int64',
                                'uint64', 'int16', 'uint16', 'int8', 'uint8']
                    candidates = [candidate for candidate in priority if candidate in candidates]
                    if not candidates:
                        raise RuntimeError('The scanner did not identify a numeric type for this result.')
                    rows.append({'address': '0x' + match.group(2), 'scan_value': match.group(3),
                                 'kind': candidates[0], 'candidate_kinds': candidates})
            return {'count': count, 'results': rows}
        raise ValueError('Unknown scanner request.')

def main():
    scanner = Scanner()
    # Keep a separate descriptor for JSON. Native scanmem redirects fd 1 while
    # executing commands; progress must bypass that capture rather than vanish
    # into the native output file or corrupt a result line.
    with os.fdopen(os.dup(1), 'w', buffering=1) as protocol:
        write_lock = threading.Lock()
        def send(payload):
            with write_lock:
                protocol.write(json.dumps(payload, allow_nan=False) + '\n')
                protocol.flush()
        try:
            for line in sys.stdin:
                done = threading.Event()
                reporter = None
                try:
                    request = json.loads(line)
                    if request.get('action') == 'scan':
                        baseline = float(scanner.lib.sm_get_scan_progress())
                        send({'event': 'scan_progress', 'progress': 0.0})
                        def report():
                            fresh = False
                            while not done.wait(0.1):
                                progress = float(scanner.lib.sm_get_scan_progress())
                                # Until the native scan resets or advances its
                                # counter, the getter may still contain the last
                                # scan's 100%. Never present that as this scan.
                                fresh = fresh or abs(progress - baseline) > 1e-9
                                if fresh and math.isfinite(progress):
                                    send({'event': 'scan_progress', 'progress': max(0.0, min(1.0, progress))})
                        reporter = threading.Thread(target=report, daemon=True)
                        reporter.start()
                    result = {'ok': True, 'data': scanner.handle(request)}
                except Exception as error:
                    result = {'ok': False, 'error': str(error)}
                finally:
                    done.set()
                    if reporter:
                        reporter.join()
                if reporter and result['ok']:
                    send({'event': 'scan_progress', 'progress': 1.0})
                send(result)
        finally:
            scanner.lib.sm_cleanup()

if __name__ == '__main__':
    main()
