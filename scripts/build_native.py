"""Build Memory Deck's vendored libscanmem for little-endian Linux x86-64."""
import os
import platform
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'backend' / 'scanmem'

def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise SystemExit('Build on Linux x86-64 (SteamOS or an x86-64 Linux builder).')
    build = ROOT / 'build' / 'native'
    build.mkdir(parents=True, exist_ok=True)
    (ROOT / 'bin').mkdir(exist_ok=True)
    # These are the configure results for the supported Linux/glibc target.
    # Disable C23 redirects when building on a newer glibc, keeping the binary
    # usable on SteamOS installations with older glibc versions.
    (build / 'config.h').write_text('''#pragma once
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include <features.h>
#undef __GLIBC_USE_C2X_STRTOL
#define __GLIBC_USE_C2X_STRTOL 0
#define HAVE_PROCMEM 1
#define HAVE_GETLINE 1
#define HAVE_SECURE_GETENV 1
#define PACKAGE_VERSION "0.18-value-forge"
#define PACKAGE_BUGREPORT "https://github.com/scanmem/scanmem"
''')
    names = ['common', 'show_message', 'commands', 'ptrace', 'handlers',
             'interrupt', 'maps', 'scanmem', 'scanroutines', 'sets',
             'targetmem', 'value']
    subprocess.run([os.environ.get('CC', 'gcc'), '-std=gnu99', '-O2',
                    '-fPIC', '-shared', '-D_GNU_SOURCE', '-D_FILE_OFFSET_BITS=64',
                    '-I' + str(build), '-I' + str(SOURCE),
                    '-include', str(build / 'config.h'),
                    '-Wl,-soname,libscanmem.so.1', '-o',
                    str(ROOT / 'bin' / 'libscanmem.so.1.0.0'),
                    *[str(SOURCE / (name + '.c')) for name in names], '-lm'], check=True)
    print('Built bin/libscanmem.so.1.0.0')

if __name__ == '__main__':
    main()
