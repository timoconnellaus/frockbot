#!/usr/bin/env bash
# Local "dogfood" dev stack: the real Worker, the real Vue client, real Workers
# AI through the Flock AI Gateway, and the real Computer host service binding.
#
#   scripts/dogfood/dev-stack.sh [start]   build, seed, serve, wait, report
#   scripts/dogfood/dev-stack.sh stop      kill wrangler / workerd / vite
#   scripts/dogfood/dev-stack.sh status    reprint the sign-in and health notes
#
# `start` is idempotent: it stops a previous stack first.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cloudflare_root="$repo_root/apps/cloudflare"
main_checkout="${FROCKBOT_MAIN_CHECKOUT:-$HOME/repos/grokbot-headless}"

worker_port="${FROCKBOT_DEV_WORKER_PORT:-8787}"
client_port="${FROCKBOT_DEV_CLIENT_PORT:-5173}"
worker_url="http://127.0.0.1:${worker_port}"
client_url="http://127.0.0.1:${client_port}"

state_dir="$repo_root/.dogfood"
log_dir="${CLAUDE_JOB_DIR:+$CLAUDE_JOB_DIR/tmp}"
log_dir="${log_dir:-$state_dir/logs}"
mkdir -p "$log_dir" "$state_dir"
worker_log="$log_dir/wrangler.log"
client_log="$log_dir/vite.log"

say() { printf '\033[1;36m[dogfood]\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m[dogfood]\033[0m %s\n' "$*" >&2
  exit 1
}

# ------------------------------------------------------------------ stop

stop_stack() {
  say "stopping any running stack"
  # `wrangler dev` is a Node parent supervising workerd. Killing one alone
  # leaves the other holding the port, and the next `wrangler dev` then
  # silently picks 8788 instead of failing.
  pkill -9 -f 'wrangler/wrangler-dist/cli.js' 2>/dev/null || true
  pkill -9 -f workerd 2>/dev/null || true
  pkill -9 -f 'vite.*--host 127.0.0.1' 2>/dev/null || true
  for port in "$worker_port" "$client_port"; do
    holders="$(lsof -ti "tcp:${port}" 2>/dev/null || true)"
    if [ -n "$holders" ]; then
      # shellcheck disable=SC2086
      kill -9 $holders 2>/dev/null || true
    fi
  done
  rm -f "$state_dir/wrangler.pid" "$state_dir/vite.pid"
  sleep 1
}

# ------------------------------------------------------------------ helpers

ensure_dev_vars() {
  target="$cloudflare_root/.dev.vars"
  if [ ! -f "$target" ]; then
    if [ -f "$main_checkout/apps/cloudflare/.dev.vars" ]; then
      say "copying .dev.vars from $main_checkout"
      cp "$main_checkout/apps/cloudflare/.dev.vars" "$target"
    else
      die "$target is missing. Copy .dev.vars.example and fill it in; without CREDENTIAL_KEYRING the User Durable Object throws \"Credential Store Contribution is not configured\"."
    fi
  fi
  grep -q '^CREDENTIAL_KEYRING=' "$target" \
    || die "CREDENTIAL_KEYRING is missing from $target"
}

# The `development` environment marks AI, MEMORY_FILES and MEMORY_INDEX
# `remote`, so `wrangler dev` opens a proxy session against the Cloudflare API.
# That proxy is exactly what makes the AI binding *real* Workers AI through the
# `flock` AI Gateway. Without credentials wrangler refuses to start at all, so
# check before spending a build on it.
cloudflare_authenticated() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && return 0
  (cd "$cloudflare_root" && bunx wrangler whoami >/dev/null 2>&1)
}

wait_for_manifest() {
  deadline=$((SECONDS + 240))
  while [ "$SECONDS" -lt "$deadline" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' \
      -H 'x-frockbot-user-id: development' \
      "$worker_url/app-manifest" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  die "timed out waiting for $worker_url/app-manifest - see $worker_log"
}

wait_for_client() {
  deadline=$((SECONDS + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -sf -o /dev/null "$client_url/" && return 0
    sleep 1
  done
  die "timed out waiting for $client_url - see $client_log"
}

# ------------------------------------------------------------------ seed

seed_object() {
  key="$1"
  file="$2"
  (cd "$cloudflare_root" && bunx wrangler --env development r2 object put \
    "$key" --file "$file" --content-type application/json --local >/dev/null)
}

build_and_seed() {
  say "building the client bundle and the foundation artifact"
  (cd "$cloudflare_root" && bun run artifact:build)

  say "seeding applications/foundation-v1.mjs into the local R2 bucket"
  (cd "$cloudflare_root" && bunx wrangler --env development r2 object put \
    frockbot-application-artifacts/applications/foundation-v1.mjs \
    --file dist/artifacts/foundation-v1.mjs --local)

  # Without this the better-auth tables do not exist and /api/debug/users
  # answers `D1_ERROR: no such table: user`. Development sign-in itself does
  # not read them, but the operator surface does.
  say "applying the local D1 auth migrations"
  (cd "$cloudflare_root" && bunx wrangler --env development d1 migrations apply \
    frockbot-auth-development --local >/dev/null)

  say "publishing and seeding a Package Catalog generation"
  source_dir="$state_dir/catalog-source"
  rm -rf "$source_dir"
  (cd "$repo_root" && bun scripts/publish-catalog.ts --out "$source_dir")
  generation="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).generation)' "$source_dir/catalog/current")"
  [ -n "$generation" ] || die "the published Catalog pointer names no generation"

  # The index and the entries first, so the pointer never names a generation
  # whose documents are not there yet.
  seed_object "frockbot-package-catalog/catalog/${generation}/index.json" \
    "$source_dir/catalog/${generation}/index.json"
  for entry in "$source_dir/catalog/${generation}/entry/"*.json; do
    [ -e "$entry" ] || break
    seed_object \
      "frockbot-package-catalog/catalog/${generation}/entry/$(basename "$entry")" \
      "$entry"
  done
  seed_object "frockbot-package-catalog/catalog/current" \
    "$source_dir/catalog/current"
}

# ------------------------------------------------------------------ start

start_stack() {
  ensure_dev_vars
  stop_stack

  remote_flag=""
  model_note="real Workers AI through the \`flock\` AI Gateway"
  if cloudflare_authenticated; then
    say "Cloudflare credentials present: remote bindings (AI, MEMORY_*) are live"
  else
    remote_flag="--local"
    model_note="NO MODEL - remote bindings are disabled"
    printf '\033[1;33m[dogfood]\033[0m %s\n' \
      "WARNING: wrangler is not authenticated, so the remote AI binding cannot" >&2
    printf '            %s\n' \
      "start and the stack would refuse to boot. Falling back to --local:" >&2
    printf '            %s\n' \
      "the UI and sign-in work, but every model turn will fail." >&2
    printf '            %s\n' \
      "Fix with an interactive \`bunx wrangler login\` in apps/cloudflare, or" >&2
    printf '            %s\n' \
      "export CLOUDFLARE_API_TOKEN=... (Workers AI + AI Gateway read) first." >&2
  fi

  # `PACKAGE_BUNDLER` and `COMPUTER_HOST` are service bindings, and a service
  # binding only resolves to a Worker in the *same* `wrangler dev` session.
  # Neither joins this one, so both read `[not connected]` — the same state
  # `bun run dev:cloudflare` has. See docs/dogfood/dev-stack.md for what a
  # live Computer would additionally need; it is blocked on a secret, not on
  # this script.
  if ! grep -q '^COMPUTER_HOST_TOKEN=' "$cloudflare_root/.dev.vars"; then
    printf '\033[1;33m[dogfood]\033[0m %s\n' \
      "note: no COMPUTER_HOST_TOKEN in apps/cloudflare/.dev.vars, so the Computer" >&2
    printf '            %s\n' \
      "stays off and the Computer card reads \"Set SPRITES_TOKEN to attach a computer\"." >&2
  fi

  build_and_seed

  say "starting wrangler dev on :$worker_port (log: $worker_log)"
  (
    cd "$cloudflare_root"
    # shellcheck disable=SC2086
    nohup bunx wrangler dev \
      --env development \
      --ip 127.0.0.1 \
      --port "$worker_port" \
      --var ALLOW_DEVELOPMENT_AUTH:true \
      $remote_flag \
      >"$worker_log" 2>&1 &
    echo $! >"$state_dir/wrangler.pid"
  )

  say "starting vite on :$client_port (log: $client_log)"
  (
    cd "$cloudflare_root"
    FROCKBOT_DEV_GATEWAY_URL="$worker_url" nohup bunx vite --host 127.0.0.1 \
      >"$client_log" 2>&1 &
    echo $! >"$state_dir/vite.pid"
  )

  wait_for_manifest
  wait_for_client
  status_stack
}

status_stack() {
  echo
  say "stack is up"
  printf '  Worker      %s   (pid %s)\n' "$worker_url" \
    "$(cat "$state_dir/wrangler.pid" 2>/dev/null || echo '?')"
  printf '  Client UI   %s   (pid %s)\n' "$client_url" \
    "$(cat "$state_dir/vite.pid" 2>/dev/null || echo '?')"
  printf '  Logs        %s\n' "$log_dir"
  printf '  Model       %s\n' "${model_note:-unknown - run start to find out}"
  echo
  say "sign in"
  echo "  Open $client_url and click \"Continue as local developer\"."
  echo "  The button appears only on localhost / 127.0.0.1 / ::1, uses the fixed"
  echo "  \`development\` identity, and needs no Google credentials. The vite proxy"
  echo "  also stamps \`x-frockbot-user-id: development\` onto /api and /app-manifest."
  echo
  say "health and debug"
  echo "  curl -s -o /dev/null -w '%{http_code}\\n' -H 'x-frockbot-user-id: development' $worker_url/app-manifest"
  echo "  FROCKBOT_DEBUG_URL=$worker_url .claude/skills/frockbot-debug/scripts/debug.sh users"
  echo
  say "stop with: scripts/dogfood/dev-stack.sh stop"
}

case "${1:-start}" in
  start) start_stack ;;
  stop)
    stop_stack
    say "stopped"
    ;;
  status) status_stack ;;
  *) die "usage: dev-stack.sh [start|stop|status]" ;;
esac
