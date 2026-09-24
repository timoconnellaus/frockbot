---
name: babysit
description: Own FrockBot's delivery pipeline once a pull request is open — keep main green, merge ready pull requests, and see each release reach production. Use when the user says "babysit", "babysit this", "babysit the PRs", "manage the PRs", "merge what's ready", "is main green", "why is main red", asks whether a change has shipped, or runs /babysit or /loop /babysit.
---

# Babysit

An authoring session's job ends when its pull request is open and its own
checks are green. From there a babysitter owns everything: the merge, `main`,
the release tag and production. Babysitters are the only thing that merges,
and any number can run at once — one per authoring session, plus one
watching everything. One run is a **tick**; a tick is safe to repeat, so
`/loop /babysit` runs it on a self-paced schedule, overnight included.

Merging is shipping. A green `main` tags itself and deploys
`bot.frockbot.com` about twenty minutes later with nobody in between, so
treat every merge as a production deploy.

## Starting

"Babysit this" means keep babysitting, not look once. Unless this turn is
already a `/loop` firing, invoke the `loop` skill yourself — nobody should
have to type the slash commands — and it runs the first tick and paces the
rest. Run a single tick without the loop only for a question that wants one
answer: "is main green?", "has #812 shipped?".

**Scope.** "Babysit this", in a session that opened pull requests, watches
those: loop `/babysit #812` (every number the session opened), and each tick
snapshots with `--pr 812`. A scoped babysitter merges and repairs only its
own pull requests, follows each through to production, and stops its loop
once every one has shipped or closed — the snapshot's `landed` lines say
which. "Babysit", "babysit the PRs" or "babysit everything" watches every
open pull request and never stops by itself; stop it when Tim says so.

**Together.** Two babysitters merging is harmless: `--match-head-commit`
and the ruleset refuse a second merge, and a refused merge means take a new
snapshot. What must not happen twice is a repair, so a red `main` is claimed
(below), and an idle pull request is taken over only after saying so on it
and only with `--force-with-lease`.

## A tick

1. **Snapshot.** `bun scripts/babysit.ts` (add `--json` to read fields).
   It reads GitHub and changes nothing. `gh` fails TLS inside the Bash
   sandbox, so run it, and every `gh` call below, with the sandbox off.
2. **`main`**, then **production**, then **pull requests**, in that order —
   each section below. `main` goes first because it decides whether
   anything may merge.
3. **Report** (below), then pace the next tick.

Never act on a snapshot older than the tick: after a merge, a rerun or a
push, take a new one before deciding anything else.

## `main`

**Green:** nothing to do. If a run is in flight over merges you made, note it.

The snapshot counts a run as red unless it passed: a job that hits its
timeout shows as `cancelled`, and a failed run you reran stays red
(`rerunning`) until its new attempt passes. Only a run the concurrency group
displaced before it started is passed over.

**Red — stop the line.** Only a pull request labelled `fix-main`, or a
revert, may merge until `main` is green; the snapshot marks every other
green pull request `held`, and the `main-health` status makes GitHub
refuse those merges for everyone else too.

**Claim the repair first.** The snapshot's `repair claimed` line is an open
issue labelled `main-red`. If there is one, another babysitter owns the
repair: hold, and do nothing below unless the claim has been silent for 30
minutes, in which case comment that you are taking it over. If there is
none, open one — `gh issue create --label main-red --title "main red since
<time>: <failed jobs>"`, body naming the run — then check again that yours
is the oldest open `main-red` issue; if another was opened first, close
yours and hold. The owner comments what it finds and does, and closes the
issue once `main` is green. Then, in order:

1. **Read the failure.** `gh run view <id> --log-failed > <scratch>/main-<id>.log`
   and grep it: Playwright `✘`/`›` lines and the numbered summary, vitest
   `FAIL`/`×`/`AssertionError`. Don't read whole logs into context.
2. **Flake or regression?** Most red is real: three in four red runs in
   September were regressions a pull request introduced. It is a flake
   when the failure is infrastructure (`Network connection lost`,
   `ERR_CONNECTION_REFUSED`, a blank `✘ [ERROR]` from wrangler, OOM, a job
   cancelled at its limit), or when the test has an open issue labelled
   `flaky`, or when the same test passed on a later or earlier run over the
   same code. A failure in an area a suspect changed, or one that fails the
   same way twice, is a regression.
3. **Flake:** `gh run rerun <id> --failed`, once per run — never a second
   time. When the rerun passes, record the flake: find the issue
   (`gh issue list --label flaky --search "<test name>"`) and add the run
   link, or open one titled with the test's file and name, labelled `flaky`.
   That list is what "known flake" means next time.
4. **Regression: attribute it.** The snapshot's suspects are every landing
   between the last green commit and the failing head. Match the failing
   test's area to their diffs (`gh pr diff <n> --name-only`). Say which one
   and why; if you can't narrow it, say that.
5. **Is someone already on it?** Check open pull requests (label
   `fix-main`, titles naming the test or area) and anything merged since
   the failing head. Two sessions repairing the same break once broke
   `main` a third time (#463/#465 → #466). If a fix is open, get it
   merged; don't write a second.
6. **Repair.** A small, clear fix: a worktree off `origin/main`, the fix,
   a pull request labelled `fix-main`, merged as soon as its checks pass.
   Otherwise, once `main` has been red for 30 minutes with the culprit
   identified and no fix under way: revert it (below). A revert is not a
   judgement on the work; it reopens it. If you can't identify the culprit,
   say so and keep narrowing; never revert a guess.

**Reverting.** `git revert --no-edit <sha>` for a squash, or
`git revert --no-edit -m 1 <sha>` for a merge commit, on a branch off
`origin/main`; open it titled `Revert "<original title>"` (the snapshot and
`main-health` treat that title as a repair); link the failing run in the
body; comment on the original pull request with the failure and what to
reland.

## Production

The snapshot's `prod` line is `ci-watch.ts release <tag>` for the highest
tag. A release that failed before `Deploy FrockBot app` succeeded means
production is behind `main`: read the failed step; rerun failed jobs once
when it is infrastructure; otherwise tell Tim. Failures after the deploy
(npm, the Mac app, the GitHub release) are worth a line, not an alarm.

You never push a tag, approve a deployment, or run wrangler against
production. Those are Tim's.

## Pull requests

The snapshot gives each open pull request an action:

- **merge** — green, mergeable, and `main` is green (or it repairs `main`).
  `gh pr merge <n> --squash --delete-branch --match-head-commit <headSha>`.
  `--match-head-commit` refuses if someone pushed after the checks you saw.
  Merge every ready one; the snapshot's suspects list keeps attribution
  honest if the combination breaks `main`. A merge GitHub refuses means the
  snapshot is stale: take a new one rather than retrying.
- **fix** — a check failed. A flake (same tests as above): rerun the failed
  jobs once (`gh run rerun <run> --failed`; `gh pr checks <n>` gives the
  run). A real failure: leave it while the author is active — idle under
  30 minutes means its session is probably on it. Idle longer: check out
  the branch in a worktree (`gh pr checkout <n>`), fix it, push, and say
  so on the pull request.
- **rebase** — conflicts with `main`. Same idle rule. In a worktree:
  `git fetch origin main && git rebase origin/main`, resolve,
  `bun install --frozen-lockfile`, `git push --force-with-lease`. A
  conflict in a generated file (`*.generated.ts`) is resolved by taking
  either side and running its generator — `bun app/whats-new/generate.ts`
  for What's New — never by hand.
- **wait** — checks running, or GitHub still deciding mergeability (it
  computes that when first asked, so the next snapshot usually has it), or
  `main-health` behind `main`. If `main-health` still disagrees with the
  snapshot a tick later, refresh it: `gh workflow run main-health.yml`.
- **held** — green, but `main` is red. Nothing; it merges when `main` is
  green again. A failing `main-health` is this, never a `fix`.
- **skip** — draft, labelled `hold`, not based on `main`, changes
  requested, or from a fork. A fork's pull request is an outside
  contribution to a public repository whose merges deploy production: never
  merge, push to or rerun it; list it once under "needs Tim".

Dependabot pull requests go through the same actions; a bump that breaks
`Check` in a way that isn't a one-line fix goes to Tim.

The labels are `hold` (leave it alone), `fix-main` (repairs a red `main`),
`flaky` (issues) and `main-red` (the repair claim). If one is missing,
create it with `gh label create`.

## Boundaries

Never push to `main`, arm auto-merge, push a tag, deploy, change repository
settings or rulesets, close a pull request, or force-push without
`--force-with-lease`. Code you write here — a fix, a rebase, a revert — goes
through a pull request like anyone's, and through the gate's review when the
change is more than mechanical.

## Report

Every tick ends with a few lines: state first, then what you did, then what
needs Tim. Leave out what hasn't changed since the last tick.

```
main green · prod v0.7.192 deployed 12m ago
merged #801 Add a thing · reran flaky e2e core 4/4 (run 3594…) · rebased #799
waiting #802 (Check) · held none
needs Tim: #757 Dependabot bump breaks Check (ajv types), not a one-line fix
```

Raise a "needs Tim" item once, and again only when it changes. Stale work —
a draft or `hold` older than a week, a `fix` idle for two days — is a line
once a day, not every tick.

## Pacing under `/loop`

Wake when there is something to see, not on a timer:

- `main` red, or a run in flight over a merge you made: about 5 minutes
  (a `main` run takes ~13).
- Pull requests waiting on checks: about 5 minutes (`Check` takes ~5).
- Nothing moving: 20–30 minutes.
