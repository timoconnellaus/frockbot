#!/bin/bash
# FrockBot cloud environment: toolchains only, installed once per environment cache.
# A setup script that exits non-zero stops the session from starting, so failures only warn.
#
# The cloud environment runs the copy pasted into its settings on claude.ai, not
# this file. Change this file first, then paste it there.
set -uo pipefail

# Bun, pinned to CI and package.json's packageManager (the image ships 1.3.11).
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6" || echo "bun pin failed" >&2

# Flutter 3.47.0, as CI pins: the Flutter job, and the integration/e2e/build tiers,
# which build the web client with `flutter build web`.
(
  curl -fsSL https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.0-stable.tar.xz \
    | tar -xJ --no-same-owner -C /opt \
    && ln -sf /opt/flutter/bin/flutter /opt/flutter/bin/dart /usr/local/bin/ \
    && flutter config --no-analytics >/dev/null \
    && flutter precache --web
) || echo "flutter install failed" >&2 &

# Chromium for Playwright 1.63's browser suite (the image only has an older build).
(
  cd /tmp && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx -y playwright@1.63.0 install chromium
) || echo "playwright chromium install failed" >&2 &

# Semrush CLI (unofficial, github.com/mrkooblu/semrush-mcp); reads SEMRUSH_API_KEY,
# which must be the account's v3 key. Pinned to a reviewed commit, from the tarball
# so npm skips the git dev install.
(
  npm install -g "https://codeload.github.com/mrkooblu/semrush-mcp/tar.gz/f2e858521109948aa0c024ea0d52ef7c04742913"
) || echo "semrush cli install failed" >&2 &

wait
exit 0
