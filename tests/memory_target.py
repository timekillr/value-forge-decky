"""Opt-in subprocess used exclusively by the integration tests."""
import ctypes
import json
import mmap
import os
import struct
import sys

# Permit a sibling test scanner to inspect this disposable process under Yama.
libc = ctypes.CDLL(None)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl(0x59616D61, ctypes.c_ulong(-1).value, 0, 0, 0)
region = mmap.mmap(-1, 4096)
address = ctypes.addressof(ctypes.c_char.from_buffer(region))
formats = {'int32': ('i', 0), 'float64': ('d', 16), 'uint64': ('Q', 32), 'float32': ('f', 48), 'int32_copy': ('i', 64)}
initial = {'int32': 1379467285, 'float64': 17382.625, 'uint64': 18446744073709551601, 'float32': -73.125, 'int32_copy': 1379467285}
for kind, value in initial.items():
    fmt, offset = formats[kind]
    region[offset:offset + struct.calcsize(fmt)] = struct.pack('<' + fmt, value)
print(json.dumps({'pid': int(os.readlink('/proc/self')), 'addresses': {k: hex(address + v[1]) for k, v in formats.items()}}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    fmt, offset = formats[message['kind']]
    size = struct.calcsize(fmt)
    if 'value' in message:
        region[offset:offset + size] = struct.pack('<' + fmt, message['value'])
    print(json.dumps({'value': str(struct.unpack('<' + fmt, region[offset:offset + size])[0])}), flush=True)
