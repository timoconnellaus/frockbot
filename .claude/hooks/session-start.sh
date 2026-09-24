#!/bin/bash
# Cloud sessions only. The environment cache keeps the toolchains its setup
# script installed, but not this branch's dependencies or a running dockerd.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

status=0
bun install --frozen-lockfile >/dev/null || status=$?

# Only the Plugin publication e2e spec (plugins-publish.e2e.ts) and
# dev:native need Docker, so the session does not wait for the daemon.
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  setsid dockerd >/tmp/dockerd.log 2>&1 </dev/null &
fi

exit "$status"
