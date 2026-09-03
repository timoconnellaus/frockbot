#!/usr/bin/env bash
# Local "dogfood" dev stack: the real Worker, the real Vue client, real Workers
# AI through the Flock AI Gateway, and the real Computer host service binding.
#
#   scripts/dogfood/dev-stack.sh [start]   build, seed, serve, wait, report
#   scripts/dogfood/dev-stack.sh stop      stop this stack's wrangler / workerd / vite
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

# The R2 bucket names bound by the `development` environment in
# `apps/cloudflare/wrangler.jsonc`. `wrangler r2 object put` addresses a bucket
# by *name*, not by binding, so a name that drifts from the environment seeds a
# bucket the Worker never opens: the Catalog was seeded into
# `frockbot-package-catalog` for months while `development` read
# `frockbot-package-catalog-development`, which left every fresh User with no
# `catalog/current` pointer to pin and killed `package_search` on its first
# call. `scripts/dogfood/dev-stack.test.ts` keeps the two in step.
artifact_bucket="frockbot-application-artifacts"
catalog_bucket="frockbot-package-catalog-development"

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

# Every process descended from `$1`, deepest first, including `$1` itself.
#
# `wrangler dev` is a Node parent supervising workerd, reached through a `bunx`
# shim: killing one alone leaves another holding the port, and the next
# `wrangler dev` then silently picks 8788 instead of failing. Walking the tree
# from the pid this script recorded is how the whole thing goes without
# touching anyone else's.
process_tree() {
  children="$(pgrep -P "$1" 2>/dev/null || true)"
  for child in $children; do
    process_tree "$child"
  done
  printf '%s\n' "$1"
}

stop_stack() {
  say "stopping any running stack"
  # Only this stack's own processes. A pattern kill (`pkill -f workerd`) reaches
  # every workerd on the machine, and the Playwright end-to-end harness runs its
  # own `wrangler dev`: a `dogfood:dev` start or stop while a suite is in flight
  # used to SIGKILL the harness's runtime mid-test, which surfaces as a 500 on
  # the next request and ERR_CONNECTION_REFUSED on every one after it.
  for pid_file in "$state_dir/wrangler.pid" "$state_dir/vite.pid"; do
    [ -f "$pid_file" ] || continue
    recorded="$(cat "$pid_file" 2>/dev/null || true)"
    case "$recorded" in
      "" | *[!0-9]*) continue ;;
    esac
    kill -0 "$recorded" 2>/dev/null || continue
    for pid in $(process_tree "$recorded"); do
      kill -9 "$pid" 2>/dev/null || true
    done
  done
  # Backstops for a lost pid file. Both are matched on this stack's own command
  # line — `--env development` on this port — so the end-to-end harness's
  # `wrangler dev --env e2e` on its own ephemeral port is never a match.
  for stale in $(pgrep -f "wrangler-dist/cli.js dev --env development --ip 127.0.0.1 --port $worker_port" 2>/dev/null || true); do
    for pid in $(process_tree "$stale"); do
      kill -9 "$pid" 2>/dev/null || true
    done
  done
  # And the holders of this stack's own two ports, with their descendants.
  for port in "$worker_port" "$client_port"; do
    holders="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
    for holder in $holders; do
      for pid in $(process_tree "$holder"); do
        kill -9 "$pid" 2>/dev/null || true
      done
    done
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
    "${artifact_bucket}/applications/foundation-v1.mjs" \
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
  seed_object "${catalog_bucket}/catalog/${generation}/index.json" \
    "$source_dir/catalog/${generation}/index.json"
  for entry in "$source_dir/catalog/${generation}/entry/"*.json; do
    [ -e "$entry" ] || break
    seed_object \
      "${catalog_bucket}/catalog/${generation}/entry/$(basename "$entry")" \
      "$entry"
  done
  seed_object "${catalog_bucket}/catalog/current" \
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
