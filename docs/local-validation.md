# Local validation

Commit code, then run `bun run validate`. Pre-push runs the fast tier — the
`format`, `typecheck` and `unit` categories, the same set `check.yml` runs on
the pull request — and reuses each successful category independently. The slow
categories (`runtime`, `integration`, `e2e`, `build`) run once per landed change
on `main`; run them here when a change warrants it. To run a subset, use
`bun run validate unit integration` or `bun run validate:e2e`. Add `--force` to
rerun selected categories. Plain test commands remain available but do not
produce receipts.

The separate `Flutter` job in `check.yml` and `main.yml` analyzes and tests the
Dart client, then compiles the Android Kotlin sources and runs the JVM tests,
including badge reconciliation and effect ordering, with `:app:testDebugUnitTest`.
It uses no emulator or release build. The workflow owns the Java/Gradle setup
and disposable signing configuration; these checks are not part of local Bun
validation receipts.

Selected categories run at once, except those whose commands write tracked
files: `integration`, `e2e` and `build`. Each of those runs alone, one after
another, once the rest have finished. `build` rewrites tracked generated
sources, and `integration` and `e2e` both reach the artifact build, which
resolves the Dart dependencies unconditionally and so rewrites the tracked
`apps/native/pubspec.lock`; every other category reads the work tree, through
its own commands and through the snapshot that proves the tree still matches
the commit, so a half-written tracked file aborts the run for no real reason.
The `apps/cloudflare/dist` those three share follows from that rather than
causing it. The question to ask before adding a category to that set is simply
whether anything its command runs writes a tracked file; the pre-push tier
(`format`, `typecheck`, `unit`) contains none of them and still runs together.
Every command is spawned the same way — in a process group
of its own, with both pipes read by the runner — so one signal reaches the
workers below any package-manager wrapper. The only thing that varies is where
those pipes go: output is echoed to the terminal as it arrives whenever nothing
can interleave with it, and otherwise held and printed as one block when the
command ends. That is decided per phase rather than per run, once reused
receipts are discounted: the concurrent phase echoes only when it is left
holding a single command, while each of `integration`, `e2e` and `build` echoes
as it runs, because it runs alone by construction. The first failure kills the
commands still running, and every command is waited for before the run cleans
up.

Receipts live in gitignored `.local-validation/receipts/<category>-<key>.json`.
The key is the content of everything the category reads — the committed blobs at
its input paths — together with its commands, the validator implementation and
the Bun and Node versions/platform. A receipt therefore survives an amend, a
reorder or a rebase that touches nothing the category reads; only changing an
input re-runs it. Code and configuration must be committed before validation,
including untracked source. Root Markdown files, `docs/`, and gitignored local
working files may remain dirty; they are an input to no category whose command
reads only code, so a documentation-only commit reuses those receipts. Markdown
elsewhere can contain runtime prompts and is treated as code. `format` is the
exception and takes every tracked path, prose included, because `prettier
--check .` checks the repository rather than a suite, and `.prettierignore`
exempts neither `docs/` nor root Markdown: a documentation-only commit
therefore still re-runs `format`. That is the line to check when changing a
category's command — a command that reads the repository itself cannot take the
prose exclusion, because prose can change its result. `runtime` additionally
excludes `apps/native/`, `apps/marketing/` and `apps/admin-portal/`, which
nothing it runs imports; every other category depends on everything else that
is not prose by default. The
checkout is checked before and after execution. Receipts accumulate rather than
replace one another, and nothing removes them; two commits with identical inputs
share one file, so the directory grows more slowly than the per-commit scheme it
replaced.

Dependencies must be installed from the committed lockfile (`bun install
--frozen-lockfile`). Receipts assume the installed dependencies and local test
environment remain intact; after changing either, rerun with `--force`.

Each run isolates Wrangler service discovery so concurrent worktrees cannot
replace one another’s local services. Checks also run under the shell’s
environment rather than the hook’s: `GIT_DIR` and the other per-invocation git
variables are stripped, so a check that spawns git discovers its repository from
its own working directory and not from the hook that started the push. Browser
checks reject focused `.only` tests; their worker count and retries belong to
`e2e/playwright.config.ts`, which locally runs four workers and no retries so a
failure stays failed.

An interrupted validation can leave `.local-validation/running`. Once the
process has stopped, remove that directory and retry. Failed checks remove their
previous receipt. The hook validates the outgoing commit, including peeled tag
objects, and rejects other branch heads: push those from their own checkout.
Branch deletion needs no validation. Pre-push fetches main from the push remote
and rejects merge commits introduced on the branch; a branch behind main may
push, because `main.yml` checks the merge commit itself once it lands. A fetch
failure blocks the push.

## Vitest file parallelism stays off

Categories now run concurrently, but inside `apps/cloudflare` both vitest
configs keep `fileParallelism: false`, deliberately and not as an oversight.
The fakes those suites run against are shared mutable state that files assert
exact increments on: the Computer host fake is a single Node-side closure whose
exec table, file map and call log belong to the run rather than to a file, and
the Workers AI call counter, the outbound stub's MCP handshake counter and its
blocked-address tally are each read, driven through a Turn, and asserted to
have risen by exactly one. Parallel files race on all of them, and a per-test
reset is itself a thing that races, so switching the flag on today buys
flakiness rather than speed.

## Conversation evaluation

`bun run eval:conversation` exercises the assembled Bot runtime against a live
model for a simple answer, a multipart explanation and an explicitly requested
detailed checklist, three times each. Like `eval:greeting`, it reads the main
checkout's `.dev.vars` and accepts `OLLAMA_BASE_URL` and `OLLAMA_MODEL` overrides.
It uses the configured model account and is a development check, never a CI test.

The report in `.eval-results/` records the model, source revision, requests,
ordered sends, refused send attempts, and mechanical checks for delivery,
message count, length and formatting. Its bounds apply to those example
questions, not to product payloads.
Read the saved replies as well: correctness, completeness, natural message
boundaries and repeated ideas need human review.

## GitHub configuration

The pipeline depends on three settings outside the repository. Each is what
holds a stage back; without it GitHub has nothing to wait for.

- **The `main` ruleset** requires the `Check` and `Flutter` status checks, the
  two jobs of `check.yml`; it forbids deletion and force-pushes, and requires a
  pull request. "Require branches to be up to
  date" is off: it made every landed pull request invalidate every other one,
  and `main.yml` checks the merge commit itself. Auto-merge is not enabled on
  the repository; a maintainer merges. GitHub's merge queue, which would check
  the combination before landing it, is offered only on organization-owned
  repositories, so this one has none.
- **The `production` environment** carries no protection rule. `release.yml`'s
  deploy jobs declare it, but nothing waits for a person: a verified tag reaches
  production on its own. Adding a required reviewer is the single change that
  would put one back in the path, at the cost of an approval per release.
- **Fork workflow approval** stays at GitHub's default for public repositories:
  a first-time contributor's workflows run only after a maintainer approves
  them. `check.yml` needs no secret in any case.

`Native qualification` is a manual-only workflow. Version tags, whether cut by
`main.yml` or pushed by hand, run the release verification and then the
production deployment.

Local receipts are a trusted solo-developer guardrail, not server-verifiable
proof. GitHub cannot inspect them and Git permits bypassing local hooks;
`Check` on the pull request and `main.yml` on the merge commit are what a
landed change has actually passed.
