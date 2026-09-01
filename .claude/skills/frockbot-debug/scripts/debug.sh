#!/usr/bin/env bash
# Read-only operator queries against the FrockBot /api/debug surface.
# See ../SKILL.md for what the snapshot contains and how to read it.
set -euo pipefail

BASE_URL="${FROCKBOT_DEBUG_URL:-https://bot.frockbot.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DEV_VARS="$REPO_ROOT/apps/cloudflare/.dev.vars"

usage() {
  cat <<'EOF'
usage:
  debug.sh users
  debug.sh bots <userId>
  debug.sh bot  <userId> <botId> [--events] [--limit N] [--before CURSOR]
  debug.sh run  <userId> <botId> <runId>

env:
  FROCKBOT_DEBUG_URL    default https://bot.frockbot.com
  FROCKBOT_DEBUG_TOKEN  default: DEBUG_TOKEN from apps/cloudflare/.dev.vars
EOF
}

token() {
  if [ -n "${FROCKBOT_DEBUG_TOKEN:-}" ]; then
    printf '%s' "$FROCKBOT_DEBUG_TOKEN"
    return
  fi
  if [ -f "$DEV_VARS" ]; then
    local value
    value="$(grep -m1 '^DEBUG_TOKEN=' "$DEV_VARS" | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return
    fi
  fi
  echo "no debug token: set FROCKBOT_DEBUG_TOKEN or DEBUG_TOKEN in $DEV_VARS" >&2
  exit 2
}

request() {
  local path="$1"
  local response status body
  response="$(curl -sS -w '\n%{http_code}' \
    -H "authorization: Bearer $(token)" \
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
