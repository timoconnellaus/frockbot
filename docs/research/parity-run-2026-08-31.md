# Parity run, 2026-08-31 → 2026-09-01

What the parity backlog of 2026-08-31 planned, what actually merged, and what is
left. The authority on any single capability is the parity register in
[`grokbot-computer.md`](grokbot-computer.md); this file is the run's ledger and
is not maintained after it.

## What landed

Slice letters are the backlog's. A row is `landed` here only if the register
says so at HEAD.

| Slice                         | PRs                          | Register rows                                 |
| ----------------------------- | ---------------------------- | --------------------------------------------- |
| A — turn-type tool admission  | #45, #47, #51                | 57, 57b, 57c `partial`; 40 `partial`          |
| B — Bot identity record       | #46                          | 1, 4 `landed`; 5 `partial` (the file half)    |
| C — Bot self-management tools | #49                          | 2 `landed`; 3 `divergent`, deliberately       |
| D — Routines core             | #55, #60, #66                | 15, 16 `landed`; 17, 19 `partial`             |
| E — Routine firing semantics  | #71                          | 18, 19b `landed`                              |
| F — unread and notifications  | #65                          | 56 `landed`                                   |
| H — Computer tool round-out   | #69, #76                     | 25, 29 `landed`; 27, 33 `partial`             |
| ADR 0004 — the Computer host  | #48, #52, #61, #63, #72, #81 | 23, 24, 28 `partial`                          |
| K2/K3 — Skills reach          | #57, #67                     | 22 `landed`; 21 `partial` (K1 below)          |
| L1–L3 — Catalog and MCP       | #56, #64, #70                | 41, 42, 43, 45, 55 `partial`; 44 `deferred`   |
| M — Bot templates             | #74, #82                     | 6 `landed` (ADR 0015)                         |
| O — web tools and images      | #62, #68, #77                | 47 `landed`                                   |
| P — audit                     | #75, #79                     | 30, 30b `landed`                              |
| Q — transcript search         | #53, #58, #59                | 52 `partial` (text only; media never written) |
| T — UI shell                  | #73                          | 50 `landed`; 51 `partial` (shortcut)          |
| — the browser e2e layer       | #54                          | no row; it is the fifth test layer            |

Four ADRs were written during the run: 0012 (one Computer per User), 0013
(bidirectional sync, Memory single-writer), 0014 (`catalog` provenance) and 0015
(a Bot template is a recipe and carries no Memory). ADR 0011 is still `proposed`
while the plan that carries it records itself implemented; see the owner
decisions below.

## Register statuses this pass changed

Every change below was made by reading the code at HEAD, not by reading a PR
title. Each has a footnote under the register table giving its evidence.

| Row | Was           | Now       | Why                                                                                               |
| --- | ------------- | --------- | ------------------------------------------------------------------------------------------------- |
| 7   | `partial`     | `landed`  | `profile.md` renders every Turn under GrokBot's caps and is recorded; nothing was outstanding.    |
| 9   | `landed`      | `partial` | Nothing fades. The table and its own footnote disagreed; the footnote was right.                  |
| 25  | `done`        | `landed`  | `computer_screenshot` and the takeover controls both exist; `done` was also a fourth status word. |
| 29  | `done`        | `landed`  | Background exec landed in #76; same vocabulary fix.                                               |
| 33  | `not started` | `partial` | `start-desktop.sh` **is** a flag-enforcing launcher; what is missing is the name and the rule.    |
| 56  | `partial`     | `landed`  | Cursors, derived count, authenticated mark-read, and both sidebar fan-outs are all there.         |

## Deferred, pending an owner decision

Four things are not backlog items. Each needs a decision the owner has not
made, and none of them is blocked on code.

**ADR 0011 is ready to be marked accepted, and was left `proposed`.** The plan
that carries it, [`../plans/kernel-and-isolate.md`](../plans/kernel-and-isolate.md),
records itself implemented, and each of the decision's load-bearing claims has a
named check in [`../architecture-checks.md`](../architecture-checks.md): the
three-part kernel exists as `kernel-contracts`, `kernel-agent-loop`,
`kernel-composition` and `kernel-do`, with `scripts/check-kernel-imports.ts`
failing `typecheck` on a kernel that imports a Package; a non-first-party Package
loads through Worker Loader with `globalOutbound` disabled and only
Assignment-derived bindings, and an authority-widening request becomes a durable
pending User decision (`apps/cloudflare/test/bot-isolate.workerd.ts`); activation
fails closed and quarantines a generation that fails three consecutive times
(`packages/kernel-composition/src/activation.ts`), and a revert records a new
generation the next admitted Turn activates
(`apps/cloudflare/test/composition.workerd.ts`); authoring is bounded by durable
per-User quota, and a breach is a visible failure rather than a throw
(`apps/cloudflare/test/authoring.workerd.ts`). Flipping the status is the owner's
call under "constitution before code", so this pass did not flip it.

**K1 — the user-global Skills root.** Two of row 21's three halves landed;
the third cannot without amending the constitution. `AGENTS.md` says: "Only
Skills under the Bot's own instruction root, written under the Bot's own
authority or its User's, are loaded as instructions." A root shared across all
of a User's Bots is by definition not the Bot's own instruction root. The
register puts it plainly: it "needs a new `user-instructions`
`WorkspaceRootV1` kind and an amendment to the constitution's 'the Bot's own
instruction root' sentence, which is a decision, not code." The `user` slot
exists in the catalog ordering, the caps and the ref codec, and is always
empty; `SkillRefV1` already declares the source so widening it later is no wire
change.

**G — subagents (rows 37, 38, 39).** Held, not started. The register's first
open question is still open: "What is in `available_subagent_models` on a live
chat turn? The slug list is injected per turn and read by the one schema
function; GrokBot found no second hard-coded list, and only `sand-automation`
was ever observed." Row 39 — "Only one desktop-GUI subagent at a time, because
the screen is shared" — additionally cannot be proved anywhere but against a
live Sprite under contention, which nothing in CI does.

**N — Channels (rows 35, 36, 57f).** Superseded on 2026-09-01: the owner
removed this capability as not needed yet. The Packages, runtime paths, UI, and
empty info-pane placeholder described by this run no longer exist; the parity
register records the decision.

## Open follow-ups

- **No live Sprite in CI.** Every Computer row above is code with a named unit
  or workerd check and no standing proof against real infrastructure.
  `bun run --filter @frockbot/computer-host test:live` is the only thing in the
  repository that touches a Sprite; it needs Docker and `SPRITES_TOKEN` and is
  run by hand. It is the largest unquantified risk in the parity work.
- **A Cloudflare API token would widen two layers.** The `development` Wrangler
  environment marks `MEMORY_FILES`, `MEMORY_INDEX` and `AI` remote, and a remote
  binding makes `wrangler dev` open a Cloudflare API session a pull request has
  no credential for. Both the integration and e2e layers work around it — the
  `e2e` environment is the same Worker with local bindings and no Vectorize or
  Workers AI — so nothing in CI exercises the real Vectorize index or the real
  Workers AI binding that `generate_image` and the memory embeddings use.
- **Timing-sensitive tests.** The Sprite slot-reclamation specs were rewritten
  to stop flaking (`test(fly-sprite): make the slot-reclamation tests fast
enough not to flake`). Any further check written against a real wall clock
  should assume the same treatment.
- **Issue #7 (Dependabot).** Open, and larger than a bump: it carries
  TypeScript 5.9 → 7.0, Vite 7 → 8, `@types/node` 22 → 26, and
  `@fly/sprites` 0.1.0 → 0.2.0. The last one is not routine — ADR 0004 pins
  `@fly/sprites` to exactly `0.1.0` and records three measured defects in that
  0.x, so the bump needs `test:live` against a real Sprite before it can be
  believed, and the pin is deliberate until then.
