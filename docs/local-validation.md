# Local validation

Commit code, then run `bun run validate`. Pre-push runs the same command and
reuses each successful category independently. To run a subset, use
`bun run validate unit integration` or `bun run validate:e2e`. Add `--force` to
rerun selected categories. Plain test commands remain available but do not
produce receipts.

Receipts live in gitignored `.local-validation/<commit>/<category>.json`.
They match the commit, category commands, validator implementation and Bun and Node
versions/platform. Code and configuration must be committed before validation,
including untracked source. Root Markdown files, `docs/`, and gitignored local
working files may remain dirty. Markdown elsewhere can contain runtime prompts
and is treated as code. Commit changes, even documentation-only ones, invalidate
all categories. The checkout is checked before and after execution.

Dependencies must be installed from the committed lockfile (`bun install
--frozen-lockfile`). Receipts assume the installed dependencies and local test
environment remain intact; after changing either, rerun with `--force`.

An interrupted validation can leave `.local-validation/running`. Once the
process has stopped, remove that directory and retry. Failed checks remove their
previous receipt. The hook validates the outgoing commit, including peeled tag
objects, and rejects other branch heads: push those from their own checkout.
Branch deletion needs no validation. Before and after validation, pre-push fetches
main from the push remote and requires it to be an ancestor of HEAD. It also
rejects merge commits introduced on the branch. A fetch failure blocks the push.

## GitHub configuration

The lightweight `PR gate` checks ancestry and rejects merge commits introduced
on the PR branch. Configure main's ruleset to require `PR gate`, replacing
`Validate` and `Browser end-to-end`, and enable **Require branches to be up to
date before merging**. Keep required PRs and disable bypasses for ordinary
merging. The strict setting is essential: a workflow's ancestry check alone
cannot protect against main advancing after the check passes. Rebase and
validate again when another PR lands first. Auto-merge remains enabled.

Local receipts are a trusted solo-developer guardrail, not server-verifiable
proof. GitHub cannot inspect them and Git permits bypassing local hooks.

`CI` and `Native qualification` are manual-only workflows. This also pauses
automatic staging deployment. Version tags still run the existing release
verification and production deployment. To restore automatic CI, restore the
push/pull_request triggers from Git history and restore its required status
checks in the ruleset. Restore native workflow triggers separately if wanted.
