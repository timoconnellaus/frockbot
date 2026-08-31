#!/usr/bin/env bash
# Delegate one well-scoped task to glm-5.3-flash via the ollama CLI.
#
# Usage:
#   delegate.sh -t "task text" [-c file]... [-o out.md] [--json] [--think low|medium|high]
#   delegate.sh -f task.md      [-c file]... [-o out.md] [--json] [--think low|medium|high]
#
# The prompt sent to the model is: task text, then each -c file wrapped in a
# fenced block labelled with its path. The model has no tools and no filesystem:
# everything it needs must be in the task text or the -c files.
#
# Output goes to -o (default: a timestamped file under $OLLAMA_DELEGATE_OUT or
# the scratchpad) and the path is printed on stdout.
set -euo pipefail

MODEL="${OLLAMA_DELEGATE_MODEL:-glm-5.3-flash:cloud}"
task=""
task_file=""
out=""
json=0
think=""
context=()

while [ $# -gt 0 ]; do
  case "$1" in
    -t)
      task="$2"
      shift 2
      ;;
    -f)
      task_file="$2"
      shift 2
      ;;
    -c)
      context+=("$2")
      shift 2
      ;;
    -o)
      out="$2"
      shift 2
      ;;
    --json)
      json=1
      shift
      ;;
    --think)
      think="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "delegate.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -n "$task_file" ]; then
  task="$(cat "$task_file")"
fi
if [ -z "$task" ]; then
  echo "delegate.sh: a task is required (-t text or -f file)" >&2
  exit 2
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "delegate.sh: ollama CLI not found on PATH" >&2
  exit 3
fi
if ! ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
  echo "delegate.sh: model '$MODEL' is not available; run: ollama pull $MODEL" >&2
  exit 3
fi

if [ -z "$out" ]; then
  outdir="${OLLAMA_DELEGATE_OUT:-${CLAUDE_SCRATCHPAD:-${TMPDIR:-/tmp}}}"
  mkdir -p "$outdir"
  out="$outdir/ollama-delegate-$(date +%Y%m%d-%H%M%S)-$$.md"
fi

prompt="$(mktemp)"
trap 'rm -f "$prompt"' EXIT
{
  printf '%s\n' "$task"
  for file in "${context[@]:-}"; do
    [ -z "$file" ] && continue
    if [ ! -f "$file" ]; then
      echo "delegate.sh: context file not found: $file" >&2
      exit 2
    fi
    printf '\n\n=== FILE: %s ===\n```\n' "$file"
    cat "$file"
    printf '\n```\n'
  done
} >"$prompt"

args=(run "$MODEL" --hidethinking --nowordwrap)
[ "$json" -eq 1 ] && args+=(--format json)
[ -n "$think" ] && args+=(--think "$think")

if ! ollama "${args[@]}" <"$prompt" >"$out" 2>"$out.stderr"; then
  echo "delegate.sh: ollama failed; see $out.stderr" >&2
  exit 4
fi
rm -f "$out.stderr"

# Strip the terminal control sequences ollama emits around its output.
perl -pi -e 's/\e\[\?25[lh]//g' "$out"

echo "$out"
