"""Create a directly installable Decky ZIP, including corresponding source."""
import hashlib
import argparse
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', '.vscode', 'node_modules', '__pycache__', 'build', 'artifacts', 'image'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', action='store_true',
                        help='Also create the fixed-name GitHub release asset and SHA256SUMS.')
    args = parser.parse_args()
    package = json.loads((ROOT / 'package.json').read_text())
    for name in ['dist/index.js', 'bin/libscanmem.so.1.0.0', 'main.py', 'session_core.py',
                 'scanner_worker.py', 'companion_server.py', 'web/index.html', 'web/app.js',
                 'web/style.css', 'web/browser-bridge.js', 'LICENSE', 'README.md', 'THIRD_PARTY.md']:
        if not (ROOT / name).is_file():
            raise SystemExit(f'Missing build input: {name}')
    destination = ROOT / 'artifacts'
    destination.mkdir(exist_ok=True)
    output = destination / f'ValueForge-{package["version"]}.zip'
    prefix = package['name']
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ROOT.rglob('*')):
            relative = path.relative_to(ROOT)
            if not path.is_file() or path.is_symlink() or any(p in SKIP for p in relative.parts):
                continue
            if relative.name.startswith('.') or relative.suffix == '.pyc':
                continue
            archive.write(path, prefix + '/' + relative.as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise SystemExit('ZIP integrity check failed.')
        manifests = [n for n in archive.namelist() if n.endswith('/plugin.json') and n.count('/') == 1]
        if manifests != [prefix + '/plugin.json']:
            raise SystemExit('Invalid Decky ZIP structure.')
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f'{output}\n{output.stat().st_size:,} bytes\nSHA-256 {digest}')
    if args.release:
        stable = destination / 'ValueForge.zip'
        shutil.copyfile(output, stable)
        (destination / 'SHA256SUMS').write_text(
            f'{digest}  {output.name}\n{digest}  {stable.name}\n')
        print(f'Release asset: {stable}\nChecksums: {destination / "SHA256SUMS"}')

if __name__ == '__main__':
    main()
