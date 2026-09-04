#!/usr/bin/env bash
# Runs `scripts/bootstrap-npm-trust.ts` against a real npm session.
#
# The TypeScript half knows which packages need a placeholder and a trusted
# publisher. This half exists because reaching npm at all takes two things
# that are easy to get wrong by hand:
#
#   - `npm trust` needs npm 11.15.0 or later, which is newer than the npm
#     most Node installations ship. A too-old npm fails with an unhelpful
#     "unknown command", so a current npm is provisioned here instead.
#   - Trust and publish operations each require a one-time password — per
#     operation, not per session, so signing in once does not settle it. npm
#     asks by printing an authentication URL and waiting for a browser to
#     confirm it, and expects to be answered several times over a run.
#
# Every npm call here and in the TypeScript half therefore runs in the
# foreground with its prompts visible. Run it after adding a Package, from a
# terminal — this cannot go through a pipe or an agent session:
#
#   bun run bootstrap:npm-trust
#
# It is idempotent. A package that npm already has is never republished and a
# package that is already trusted is left alone, so re-running after a
# half-finished attempt is the way to reconcile it.
set -euo pipefail

# `npm trust` arrived in 11.15.0. The release workflow needs only 11.5.1,
# which it checks for itself; this is the higher bar of the two.
REQUIRED_NPM=11.15.0

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# --- a current npm ---------------------------------------------------------
# `sort -V` puts the lower version first, so the required version leading its
# own comparison with the installed one means the installed one is older.
npm_is_current() {
  local installed
  installed="$(npm --version 2>/dev/null)" || return 1
  [[ "$(printf '%s\n%s\n' "$REQUIRED_NPM" "$installed" | sort -V | head -n 1)" == "$REQUIRED_NPM" ]]
}

if ! npm_is_current; then
  # Installed beside the repository's own dependencies rather than over the
  # global npm, which is shared with every other project on the machine.
  tools="$root/node_modules/.cache/npm-trust"
  if [[ ! -x "$tools/bin/npm" ]]; then
    echo "==> installing npm $REQUIRED_NPM or later into node_modules/.cache"
    mkdir -p "$tools/bin"
    npm install npm@latest --prefix "$tools/pkg" --no-audit --no-fund >/dev/null
    # A shim rather than a PATH entry into the package's own `.bin`, so the
    # node that runs npm is the one that installed it.
    cat >"$tools/bin/npm" <<EOF
#!/bin/sh
exec "$(command -v node)" "$tools/pkg/node_modules/npm/bin/npm-cli.js" "\$@"
EOF
    chmod +x "$tools/bin/npm"
  fi
  export PATH="$tools/bin:$PATH"
fi

echo "==> npm $(npm --version)"
if ! npm_is_current; then
  echo "npm $(npm --version) cannot run \`npm trust\`; $REQUIRED_NPM or later is required" >&2
  exit 1
fi

# --- an authenticated session ----------------------------------------------
# `npm whoami` needs no one-time password, so it can be asked quietly. The
# calls after it cannot.
if npm whoami >/dev/null 2>&1; then
  echo "==> authenticated as $(npm whoami)"
else
  echo "==> logging in to npm (press ENTER when it offers the browser)"
  npm login --auth-type=web
  echo "==> authenticated as $(npm whoami)"
fi

# Nothing probes the session beyond this. A `npm trust list` here would look
# like a useful preflight and would cost a one-time password of its own,
# against a session with minutes to live — better spent on the work itself.

# --- warn about a stale checkout -------------------------------------------
# The set of packages comes from `packages/` on disk, so a checkout behind
# main bootstraps the wrong set. Not fatal: a deliberate bootstrap from a
# branch that adds a Package is exactly when this script is most useful.
if git fetch origin main --quiet 2>/dev/null \
  && behind="$(git rev-list --count HEAD..origin/main 2>/dev/null)" \
  && ((behind > 0)); then
  echo "!! this checkout is $behind commits behind origin/main;" >&2
  echo "!! packages added since will not be bootstrapped." >&2
fi

# --- bootstrap -------------------------------------------------------------
# Any arguments are package names, narrowing the run further. Passing them
# through means `bun run bootstrap:npm-trust @frockbot/plugin-applets` works.
echo
plan="$(mktemp)"
trap 'rm -f "$plan"' EXIT
bun scripts/bootstrap-npm-trust.ts "$@" | tee "$plan"

# The dry run reaches npm only through `npm view`, which needs no password,
# so reading its output back costs nothing and saves asking to confirm work
# that does not exist.
if grep -q "nothing to bootstrap" "$plan"; then
  exit 0
fi

echo
read -r -p "Publish placeholders and configure trusted publishers? [y/N] " reply
[[ "$reply" == [yY]* ]] || {
  echo "Nothing was changed."
  exit 0
}

bun scripts/bootstrap-npm-trust.ts "$@" --confirm
