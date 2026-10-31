#!/bin/sh
set -eu
cd /project
exec python3 scripts/build_native.py
