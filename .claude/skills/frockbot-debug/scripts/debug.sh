#!/usr/bin/env bash
# Operator queries and the owner-only Turn send on FrockBot's /api/debug surface.
# See ../SKILL.md for what the snapshot contains and how to read it.
set -euo pipefail

BASE_URL="${FROCKBOT_DEBUG_URL:-https://bot.frockbot.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# The token lives outside every checkout, because a checkout is the one thing
# that reliably disappears: worktrees are deleted with their session, and
# `.dev.vars` is gitignored so a fresh clone never has one. The Keychain entry
# (or its XDG file fallback) survives all of that. The `.dev.vars` files are
# still read, last, because `apps/cloudflare/.dev.vars` is the copy wrangler
# loads when the endpoint is served locally.
KEYCHAIN_SERVICE="frockbot-debug-token"
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/frockbot/debug.env"
# Run from a worktree, the `.dev.vars` that exists is the main checkout's.
# `--git-common-dir` points at that checkout's `.git` from anywhere, and its
# parent is the checkout itself.
MAIN_ROOT="$REPO_ROOT"
if COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  MAIN_ROOT="$(dirname "$COMMON_DIR")"
fi
DEV_VARS_FILES=(
  "$REPO_ROOT/.dev.vars"
  "$MAIN_ROOT/.dev.vars"
  "$REPO_ROOT/apps/cloudflare/.dev.vars"
  "$MAIN_ROOT/apps/cloudflare/.dev.vars"
)
WRANGLER_DEV_VARS="$MAIN_ROOT/apps/cloudflare/.dev.vars"

usage() {
  cat <<'EOF'
usage:
  debug.sh users
  debug.sh bots <userId>
  debug.sh bot  <userId> <botId> [--events] [--limit N] [--before CURSOR]
  debug.sh run  <userId> <botId> <runId>
  debug.sh send <userId> <botId> [<text...>]   read text from stdin if omitted
  debug.sh watch <userId> <botId> <runId>      poll every 3s until settled
  debug.sh token store [<value>]   store a token durably (reads stdin if omitted)
  debug.sh token where             report which source a token resolves from

env:
  FROCKBOT_DEBUG_URL    default https://bot.frockbot.com
  FROCKBOT_DEBUG_TOKEN  overrides every stored copy

token lookup order:
  1. FROCKBOT_DEBUG_TOKEN
  2. macOS Keychain, service "frockbot-debug-token"
  3. ${XDG_CONFIG_HOME:-~/.config}/frockbot/debug.env
  4. DEBUG_TOKEN= in .dev.vars, this checkout then the main checkout
EOF
}

keychain_available() {
  [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1
}

keychain_read() {
  keychain_available || return 1
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w 2>/dev/null
}

keychain_write() {
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$USER" \
    -l "FrockBot debug token" -w "$1"
}

config_file_read() {
  [ -f "$CONFIG_FILE" ] || return 1
  local value
  value="$(grep -m1 '^DEBUG_TOKEN=' "$CONFIG_FILE" | cut -d= -f2- || true)"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

config_file_write() {
  mkdir -p "$(dirname "$CONFIG_FILE")"
  printf 'DEBUG_TOKEN=%s\n' "$1" >"$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
}

# Mirrors the token into the file wrangler loads for `bun run dev:cloudflare`,
# so a local Worker serves the same debug surface. Always the main checkout's
# copy: a worktree's would vanish with the worktree.
dev_vars_write() {
  local value="$1"
  [ -f "$WRANGLER_DEV_VARS" ] || return 0
  if grep -q '^DEBUG_TOKEN=' "$WRANGLER_DEV_VARS"; then
    local tmp
    tmp="$(mktemp)"
    sed "s|^DEBUG_TOKEN=.*|DEBUG_TOKEN=$value|" "$WRANGLER_DEV_VARS" >"$tmp"
    cat "$tmp" >"$WRANGLER_DEV_VARS"
    rm -f "$tmp"
  else
    printf 'DEBUG_TOKEN=%s\n' "$value" >>"$WRANGLER_DEV_VARS"
  fi
  printf 'mirrored to %s\n' "$WRANGLER_DEV_VARS" >&2
}

# Resolved once, at the top level: a failure inside a command substitution
# would only leave that subshell, and the request would go out unauthenticated.
# TOKEN_SOURCE is reported by `token where`, so "which copy am I using?" never
# has to be guessed from inside a worktree.
resolve_token() {
  local file value
  if [ -n "${FROCKBOT_DEBUG_TOKEN:-}" ]; then
    TOKEN="$FROCKBOT_DEBUG_TOKEN"
    TOKEN_SOURCE="FROCKBOT_DEBUG_TOKEN"
    return 0
  fi
  if value="$(keychain_read)" && [ -n "$value" ]; then
    TOKEN="$value"
    TOKEN_SOURCE="macOS Keychain ($KEYCHAIN_SERVICE)"
    return 0
  fi
  if value="$(config_file_read)"; then
    TOKEN="$value"
    TOKEN_SOURCE="$CONFIG_FILE"
    return 0
  fi
  for file in "${DEV_VARS_FILES[@]}"; do
    [ -f "$file" ] || continue
    value="$(grep -m1 '^DEBUG_TOKEN=' "$file" | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      TOKEN="$value"
      TOKEN_SOURCE="$file"
      return 0
    fi
  done
  {
    echo "no debug token found."
    echo
    echo "store one durably (survives worktrees, clones, and cleanups):"
    echo "  $0 token store"
    echo
    echo "to mint a fresh one, deploy it, and store it:"
    echo "  openssl rand -hex 32 >/tmp/tok"
    echo "  (cd '$MAIN_ROOT/apps/cloudflare' && bunx wrangler secret put DEBUG_TOKEN --env='' </tmp/tok)"
    echo "  $0 token store \"\$(cat /tmp/tok)\" && rm /tmp/tok"
    echo
    echo "looked in: FROCKBOT_DEBUG_TOKEN, Keychain, $CONFIG_FILE, and:"
    printf '  %s\n' "${DEV_VARS_FILES[@]}"
  } >&2
  return 2
}

token_command() {
  local value
  case "${1:-}" in
    store)
      value="${2:-}"
      if [ -z "$value" ]; then
        if [ -t 0 ]; then
          printf 'paste token (input hidden): ' >&2
          read -rs value
          printf '\n' >&2
        else
          read -r value
        fi
      fi
      value="$(printf '%s' "$value" | tr -d '[:space:]')"
      [ -n "$value" ] || {
        echo "empty token, nothing stored" >&2
        exit 2
      }
      if keychain_available; then
        keychain_write "$value"
        printf 'stored in macOS Keychain (%s)\n' "$KEYCHAIN_SERVICE" >&2
      else
        config_file_write "$value"
        printf 'stored in %s\n' "$CONFIG_FILE" >&2
      fi
      dev_vars_write "$value"
      ;;
    where)
      if resolve_token; then
        printf 'token source: %s\n' "$TOKEN_SOURCE"
        printf 'checkout:     %s\n' "$REPO_ROOT"
        [ "$REPO_ROOT" = "$MAIN_ROOT" ] || printf 'main checkout: %s\n' "$MAIN_ROOT"
        printf 'base url:     %s\n' "$BASE_URL"
      else
        exit 2
      fi
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

require_jq() {
  command -v jq >/dev/null 2>&1 || {
    echo "this command requires jq" >&2
    exit 2
  }
}

urlencode() {
  require_jq
  jq -rn --arg value "$1" '$value | @uri'
}

render_body() {
  local body="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq . 2>/dev/null || printf '%s\n' "$body"
  else
    printf '%s\n' "$body"
  fi
}

request_raw() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local response
  if [ "$method" = "GET" ]; then
    response="$(curl -sS -w '\n%{http_code}' \
      -H "authorization: Bearer $TOKEN" \
      "$BASE_URL$path")"
  else
    response="$(printf '%s' "$body" | curl -sS -w '\n%{http_code}' \
      -X "$method" \
      -H "authorization: Bearer $TOKEN" \
      -H "content-type: application/json" \
      --data-binary @- \
      "$BASE_URL$path")"
  fi
  HTTP_STATUS="$(printf '%s' "$response" | tail -n1)"
  HTTP_BODY="$(printf '%s' "$response" | sed '$d')"
}

request() {
  local path="$1"
  local method="${2:-GET}"
  local body="${3:-}"
  request_raw "$method" "$path" "$body"
  render_body "$HTTP_BODY"
  # A 401 here is a stale token; a 404 means the deployment has no DEBUG_TOKEN.
  if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
    printf 'HTTP %s from %s (token from %s)\n' \
      "$HTTP_STATUS" "$BASE_URL$path" "$TOKEN_SOURCE" >&2
    exit 1
  fi
}

watch_run() {
  require_jq
  local user_id="$1"
  local bot_id="$2"
  local run_id="$3"
  local path run status
  path="/api/debug/bots/$(urlencode "$bot_id")/runs/$(urlencode "$run_id")?userId=$(urlencode "$user_id")"
  while true; do
    request_raw "GET" "$path"
    if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
      render_body "$HTTP_BODY"
      printf 'HTTP %s from %s (token from %s)\n' \
        "$HTTP_STATUS" "$BASE_URL$path" "$TOKEN_SOURCE" >&2
      exit 1
    fi
    if ! run="$(printf '%s' "$HTTP_BODY" | jq -ce --arg run_id "$run_id" '.runs[]? | select(.runId == $run_id)')"; then
      echo "run $run_id was not found in the debug response" >&2
      exit 1
    fi
    status="$(printf '%s' "$run" | jq -r '.status')"
    case "$status" in
      running)
        sleep 3
        ;;
      completed | failed | interrupted | reconciliation-required | cancelled | superseded)
        printf '%s' "$run" | jq '{
          sends: [.events[]? | select(.type == "send/to-user") | .payload],
          outcome: ({status: .status}
            + (if has("responseText") then {responseText: .responseText} else {} end)
            + (if has("failure") then {failure: .failure} else {} end))
        }'
        return 0
        ;;
      *)
        printf 'run %s returned unknown status %s\n' "$run_id" "$status" >&2
        exit 1
        ;;
    esac
  done
}

command="${1:-}"
shift || true

# `token` manages the credential, so it must run before one is required.
if [ "$command" = "token" ]; then
  token_command "$@"
  exit 0
fi

resolve_token || exit $?

case "$command" in
  users)
    request "/api/debug/users"
    ;;
  bots)
    [ $# -ge 1 ] || {
      usage
      exit 2
    }
    request "/api/debug/bots?userId=$1"
    ;;
  bot)
    [ $# -ge 2 ] || {
      usage
      exit 2
    }
    user_id="$1"
    bot_id="$2"
    shift 2
    query="userId=$user_id"
    while [ $# -gt 0 ]; do
      case "$1" in
        --events) query="$query&events=true" ;;
        --limit)
          query="$query&limit=$2"
          shift
          ;;
        --before)
          query="$query&before=$2"
          shift
          ;;
        *)
          usage
          exit 2
          ;;
      esac
      shift
    done
    request "/api/debug/bots/$bot_id?$query"
    ;;
  run)
    [ $# -ge 3 ] || {
      usage
      exit 2
    }
    request "/api/debug/bots/$2/runs/$3?userId=$1"
    ;;
  send)
    [ $# -ge 2 ] || {
      usage
      exit 2
    }
    user_id="$(urlencode "$1")"
    bot_id="$(urlencode "$2")"
    shift 2
    if [ $# -gt 0 ]; then
      turn_text="$*"
    else
      turn_text="$(cat)"
    fi
    request \
      "/api/debug/users/$user_id/bots/$bot_id/turns" \
      "POST" \
      "$(jq -cn --arg text "$turn_text" '{text: $text}')"
    ;;
  watch)
    [ $# -ge 3 ] || {
      usage
      exit 2
    }
    watch_run "$1" "$2" "$3"
    ;;
  *)
    usage
    exit 2
    ;;
esac
