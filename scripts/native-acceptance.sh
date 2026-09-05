#!/usr/bin/env bash
# The runner waits for the already-paired Pixel. Never uninstall or re-key it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/Users/tim/repos/flutter/bin:${ANDROID_HOME:-/Users/tim/Library/Android/sdk}/platform-tools:$PATH"
exec python3 scripts/native-acceptance.py "$@"
