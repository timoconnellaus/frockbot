# Local validation

Commit code, then run `bun run validate`. Pre-push runs the fast tier — the
`format`, `typecheck` and `unit` categories, the same set `check.yml` runs on
the pull request — and reuses each successful category independently. The slow
categories (`runtime`, `integration`, `e2e`, `build`) run once per landed change
on `main`; run them here when a change warrants it. To run a subset, use
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

Each run isolates Wrangler service discovery so concurrent worktrees cannot
replace one another’s local services. Browser checks allow the same two retries
as the previous CI suite and reject focused `.only` tests.

An interrupted validation can leave `.local-validation/running`. Once the
process has stopped, remove that directory and retry. Failed checks remove their
previous receipt. The hook validates the outgoing commit, including peeled tag
objects, and rejects other branch heads: push those from their own checkout.
Branch deletion needs no validation. Pre-push fetches main from the push remote
and rejects merge commits introduced on the branch; a branch behind main may
push, because `main.yml` checks the merge commit itself once it lands. A fetch
failure blocks the push.

## GitHub configuration

The pipeline depends on three settings outside the repository. Each is what
holds a stage back; without it GitHub has nothing to wait for.

- **The `main` ruleset** requires the `Check` status check, forbids deletion
  and force-pushes, and requires a pull request. "Require branches to be up to
  date" is off: it made every landed pull request invalidate every other one,
  and `main.yml` checks the merge commit itself. Auto-merge is not enabled on
  the repository; a maintainer merges. GitHub's merge queue, which would check
  the combination before landing it, is offered only on organization-owned
  repositories, so this one has none.
- **The `production` environment** has the maintainer as its required
  reviewer. `release.yml`'s deploy jobs declare it, so a release waits there
  until approved on the run's page. One approval covers every job in the run.
- **Fork workflow approval** stays at GitHub's default for public repositories:
  a first-time contributor's workflows run only after a maintainer approves
  them. `check.yml` needs no secret in any case.

`Native qualification` is a manual-only workflow. Version tags, whether cut by
`main.yml` or pushed by hand, run the release verification and, behind the
approval, the production deployment.

Local receipts are a trusted solo-developer guardrail, not server-verifiable
proof. GitHub cannot inspect them and Git permits bypassing local hooks;
`Check` on the pull request and `main.yml` on the merge commit are what a
landed change has actually passed.
