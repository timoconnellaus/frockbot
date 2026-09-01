#!/usr/bin/env bash
# Read-only operator queries against the FrockBot /api/debug surface.
# See ../SKILL.md for what the snapshot contains and how to read it.
set -euo pipefail

BASE_URL="${FROCKBOT_DEBUG_URL:-https://bot.frockbot.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# The repository root first: this token is operator tooling, not one Worker's
# configuration, so it belongs where any command in the monorepo can find it.
# `apps/cloudflare/.dev.vars` is still read, because that is the only copy
# wrangler loads when the endpoint is served locally.
# `.dev.vars` is gitignored, so a worktree never inherits one: run from a
# worktree, the file that exists is the main checkout's. `--git-common-dir`
# points at that checkout's `.git` from anywhere, and its parent is the
# checkout itself.
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

usage() {
  cat <<'EOF'
usage:
  debug.sh users
  debug.sh bots <userId>
  debug.sh bot  <userId> <botId> [--events] [--limit N] [--before CURSOR]
  debug.sh run  <userId> <botId> <runId>

env:
  FROCKBOT_DEBUG_URL    default https://bot.frockbot.com
  FROCKBOT_DEBUG_TOKEN  default: DEBUG_TOKEN from .dev.vars at the repo
                        root, then apps/cloudflare/.dev.vars
EOF
}

# Resolved once, at the top level: a failure inside a command substitution
# would only leave that subshell, and the request would go out unauthenticated.
resolve_token() {
  if [ -n "${FROCKBOT_DEBUG_TOKEN:-}" ]; then
    TOKEN="$FROCKBOT_DEBUG_TOKEN"
    return 0
  fi
  local file value
  for file in "${DEV_VARS_FILES[@]}"; do
    [ -f "$file" ] || continue
    value="$(grep -m1 '^DEBUG_TOKEN=' "$file" | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      TOKEN="$value"
      return 0
    fi
  done
  {
    echo "no debug token. Set FROCKBOT_DEBUG_TOKEN, or DEBUG_TOKEN in one of:"
    printf '  %s\n' "${DEV_VARS_FILES[@]}"
  } >&2
  return 2
}

request() {
  local path="$1"
  local response status body
  response="$(curl -sS -w '\n%{http_code}' \
    -H "authorization: Bearer $TOKEN" \
    "$BASE_URL$path")"
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq . || printf '%s\n' "$body"
  else
    printf '%s\n' "$body"
  fi
  # A 401 here is a stale token; a 404 means the deployment has no DEBUG_TOKEN.
  [ "$status" = "200" ] || exit 1
}

resolve_token || exit $?

command="${1:-}"
shift || true
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
  *)
    usage
    exit 2
    ;;
esac
