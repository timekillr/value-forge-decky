"""Import the tested Android workspace unchanged, adding the browser shell.

Usage: python3 scripts/sync_web_ui.py /path/to/value-forge-companion
Run whenever Companion's workspace changes; commit generated files together.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).resolve()
assets = source / 'app/src/main/assets'
version = json.loads((source / 'package.json').read_text())['version']
commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
files = {}
for name in ('app.js', 'index.html', 'style.css'):
    content = (assets / name).read_text()
    files[name] = hashlib.sha256(content.encode()).hexdigest()
    if name == 'index.html':
        content = content.replace("connect-src 'none'", "connect-src 'self'").replace('<title>Value Forge Companion</title>', '<title>Value Forge Web</title>').replace('<script src="app.js"></script>', '<script src="browser-bridge.js"></script><script src="app.js"></script>')
    if name == 'style.css':
        content += '''
/* Browser safe areas: Android native insets are applied by its Activity instead. */
header{padding-top:calc(18px + env(safe-area-inset-top));padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}
nav{padding-bottom:calc(10px + env(safe-area-inset-bottom))}
main{padding-bottom:calc(110px + env(safe-area-inset-bottom))}
#modal{padding-bottom:calc(28px + env(safe-area-inset-bottom))}
'''
    (root / 'web' / name).write_text(content)
for name, target in [('ui.test.mjs', 'test_web_workspace.mjs'), ('connection.test.mjs', 'test_web_connection.mjs')]:
    content = (source / 'tests' / name).read_text().replace("../app/src/main/assets/", "../web/").replace('file:///android_asset/index.html', 'https://192.168.1.20:52881/')
    (root / 'tests' / target).write_text('// Shared workspace regression suite; imported by scripts/sync_web_ui.py.\n' + content)
(root / 'web' / 'UI_SOURCE.json').write_text(json.dumps({'repository':'https://github.com/timekillr/value-forge-companion', 'commit':commit, 'version':version, 'source_sha256':files}, indent=2) + '\n')
print(f'Imported Companion {version} ({commit[:12]}). Workspace logic is unchanged.')
