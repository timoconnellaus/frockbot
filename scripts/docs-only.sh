#!/usr/bin/env bash
# Reads changed paths, one per line, on stdin and exits 0 when every one of
# them is documentation, 1 otherwise. This is the single definition of
# "documentation only" that both the pre-commit hook and CI's `Classify
# changes` job use, so the two can never disagree about what a change is.
#
# Documentation is `docs/**` and the Markdown files at the repository root.
# Markdown anywhere else is deliberately code: a Package may ship a Skill or a
# prompt as `.md`, and nothing here reads a path to find out.
#
# An empty list is not documentation. It is a change with nothing to classify,
# and the full checks are the safe answer.
set -euo pipefail

seen=false
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  seen=true
  case "$path" in
    docs/*) ;;
    *.md)
      # A root-level Markdown file has no slash in its path.
      [[ "$path" == */* ]] && exit 1
      ;;
    *) exit 1 ;;
  esac
done

[[ "$seen" == true ]]
