# Plan: Slice 2 — Computer per User, Skills, Memory

## Status

steps 0, 1, and 2 landed (the shared Workspace contract; one Computer per
User; the Skills loader); step 3 not started

## Resolved decisions

- **W1** the shared Workspace file-access contract lives in
  `packages/kernel-contracts/src/workspace.ts` and is landed **before** any of
  the three steps below, so no step invents its own root, path, writer, or
  generation type.
- **W2** a durable root is identified by kind and owner (`WorkspaceRootV1`),
  never by an absolute path on the Computer. Mount paths are a Computer
  Package concern and appear only in `WorkspaceLayoutV1`.
- **W3** writer provenance for a durable-root write reuses the constitution's
  one provenance vocabulary — first-party, User, Bot — as `WorkspaceWriterV1`.
  It is not a second provenance type; `PackageProvenanceV1` in
  `@frockbot/kernel-composition` names the same kinds for a Package artifact
  and cannot be imported into `kernel-contracts` (the dependency runs the other
  way). The two must stay in step.
- **W4** a generation carries both identifiers the kernel already uses: a
  DO-minted, sortable `generationId` and a sha-256 `contentHash`. Ordering
  needs the first; conflict detection and rebuildable indexes need the second.
- **W5** Memory roots reach the kernel only as `WorkspaceMemoryProjectionV1`
  (`= WorkspaceReadsV1`). There is no write method to call and no flag to flip.
- **W6** each step keeps its `plugin-shell` backend changes in its own
  `backend-<area>.ts` — `backend-computer.ts`, `backend-skills.ts`,
  `backend-memory.ts` — and **not** in `backend.ts`. Three parallel steps
  editing one 2500-line file is the one merge conflict this plan can avoid by
  construction.

## Step 0 — the shared contract (landed)

**Goal.** One contract every later step consumes, so the three can proceed in
parallel.

**Owns.** `packages/kernel-contracts/src/workspace.ts` (+ its test),
`packages/computer-core/src/core.ts` types only.

**Exports.** `WorkspaceRootV1`, `WorkspacePathV1`, `WorkspaceWriterV1`,
`WorkspaceGenerationV1`, `WorkspaceReadsV1`, `WorkspaceFilesV1`,
`WorkspaceMemoryProjectionV1`, `SkillSourceV1`, `isLoadableSkillSourceV1`, and
their decoders; `ComputerIdentityV1`, `ComputerTenantV1`, `WorkspaceLayoutV1`.

---

## Step 1 — Computer per User (landed)

**Goal.** One Computer is provisioned per User, with each Bot a tenant on it,
per ADR 0012. Replaces the per-Bot Sprite and the separate User storage Sprite.

**Consumes.** `ComputerIdentityV1` and `ComputerTenantV1` as the provisioning
key and the caller; `WorkspaceLayoutV1` and `WorkspaceRootDeclarationV1` to
declare the durable roots the provider guarantees; `WorkspaceRootV1` to name
each declared root; `WorkspaceFilesV1` as the shape the Computer's file surface
must satisfy for non-Memory roots.

**Owns.** `packages/plugin-fly-sprite/src/*` (provisioning, the Sprite name
derivation, the `/home/box` layout, per-Bot directories and displays),
`packages/computer-core/src/core.ts` beyond the types Step 0 added — in
particular splitting `ComputerRegistry.assign`/`open` and
`ComputerProvider.open` along `ComputerIdentityV1` + `ComputerTenantV1`, and
retiring the deprecated `ComputerTarget` alias — plus
`packages/plugin-computer/src/*` and `packages/plugin-shell/src/backend-computer.ts`.

**Per-Bot assumptions unpicked** (all were function-signature-level, so Step 0
left them alone; Step 1 removed all four):

- `ComputerRegistry.assign/assignment/open` take a `ComputerTarget` and key the
  assignment map by `userId:botId`, so two Bots of one User get two
  assignments and two generations.
- `ComputerProvider.open(target, …)` receives the Bot, so a provider cannot
  distinguish "provision the Computer" from "attach this tenant".
- `flySpriteNameForTarget` (`packages/plugin-fly-sprite/src/provider.ts`)
  derives one Sprite name per (User, Bot) pair.
- `ComputerWorkspace.openDirectory({ namespace, scope, durability })` names a
  root by an untyped `namespace` string plus a `"bot" | "user"` scope, which is
  the pre-contract spelling of `WorkspaceRootV1`.

**What each became.**

- `ComputerRegistry.assign/assignment/open` take `ComputerIdentityV1` and, for
  `open`, a `ComputerTenantV1`. The assignment map is keyed by User alone.
- `ComputerProvider.open(identity, tenant, assignment, options)` — the provider
  can tell "provision the Computer" from "attach this tenant".
- `flySpriteNameForTarget` and `flySpriteNameForUserStorage` are gone, replaced
  by `flySpriteNameForComputer(identity)`: one Sprite per User, no separate User
  storage Sprite. The browser profile is the shared `/home/box/chrome-profile`.
- `openDirectory` is deleted. `ComputerWorkspace` now _is_ `WorkspaceFilesV1`
  plus its `WorkspaceLayoutV1`; `ComputerTarget` and `ComputerTargetV1` are
  deleted with it.

**Deliberately left for Step 3.** The Workspace presents Memory roots read-only
through the kernel-consumed surface, but the ADR 0013 durable-root R2 sync does
not exist, so the Memory Package still writes the Computer directly through one
named seam, `ComputerWorkspace.memoryWriter`. It accepts Memory roots and
nothing else; the kernel surface accepts everything else and no Memory root.
Step 3 deletes it.

**Tests that gate.** Two Bots of one User resolve to one Computer and one
provider Sprite; each tenant sees its own directory and display; a Bot reads
another Bot's Workspace file (organizational separation, not a boundary); an
instruction root and a Memory root of a _different_ Bot are refused a write;
`plugin-fly-sprite`'s existing tests still pass.

---

## Step 2 — Skills loader

**Goal.** The kernel loads a Bot's Skills as instructions, and only those.
Turns the `it.todo` in `packages/architecture-checks/src/turn-boundaries.test.ts`
into a real test.

**Consumes.** `SkillSourceV1`, `LoadableSkillSourceV1`,
`isLoadableSkillSourceV1`, `WorkspaceInstructionPathV1`, `WorkspaceReadsV1`
(the loader reads; it never writes), `WorkspaceGenerationV1` (the exact Skill
generation each Turn used must be reconstructable).

**Owns.** the Skills Package (`packages/plugin-skills/`), the prompt-assembly
wiring in `packages/plugin-prompt/`,
`packages/plugin-shell/src/backend-skills.ts`, and the conversion of the
`it.todo` in `turn-boundaries.test.ts`.

**Does not own.** `isLoadableSkillSourceV1` itself, or any second opinion about
which roots are loadable. A Skill that the predicate refuses is not loaded, and
the loader has no override.

**Tests that gate.** A Skill under the Bot's own instruction root written by
the Bot or its User is loaded; one written by a first-party Package, by another
Bot, or by another User is not; a file under a Memory or Package-declared root
is never loaded even when its name looks like a Skill; the session event log
records the Skill generation the Turn used; an edit is visible on the next
admitted Turn and not before.

### Landed

`packages/plugin-skills` is a first-party Package with one runtime
Contribution. What it does:

- **Format.** GrokBot's `SKILL.md` (`docs/research/grokbot-computer.md` §2.8):
  a `---` frontmatter fence carrying `name` and `description`, then a Markdown
  body. `packages/plugin-skills/src/skill-md.ts` reads a deliberately minimal
  frontmatter grammar — flat `key: value` lines, optionally quoted, no nesting
  — and refuses anything else rather than partially parsing untrusted content
  into a system prompt. Unknown keys (`license`, `metadata`, …) are read and
  ignored, so a pi or Claude Skill directory is portable in either direction.
  Bounds: 64 KiB per file, 64-character `name`, 1024-character `description`,
  200 Skills per catalog.
- **Loading.** `loadSkillCatalogV1` enumerates the Bot's `bot-instructions`
  root through the injected `WorkspaceReadsV1`, treats any `*/SKILL.md` as a
  candidate, and filters with `isLoadableSkillSourceV1`. The writer of record
  is the one the _generation_ carries, never one a caller supplies. A refusal
  is a declared variant on the catalog, never a throw.
- **Prompt shape.** Progressive disclosure, as GrokBot and pi do it: the
  catalog goes into the system prompt each Turn as `<agent_skills>` with each
  Skill's path and description; bodies never do. `skill_load` discloses one
  body on demand, and only for a Skill _this Turn_ actually loaded.
- **Self-modification.** `skill_write` renders a `SKILL.md` into
  `skills/<slug>/SKILL.md` under the Bot's own instruction root through
  `WorkspaceFilesV1`, with `{ kind: "bot", botId, sessionId, turnId, runId }`
  provenance, recording `skill/write-intent` before the write and
  `skill/written` after it.
- **Durable visibility.** Three new session events —`skill/injected`,
  `skill/write-intent`, `skill/written` — with decoders in
  `packages/kernel-contracts/src/types.ts`. `skill/injected` names every loaded
  Skill with its `generationId` and `contentHash`, and every refusal with its
  reason, once per Turn at its first step.
- **Hibernation seam.** The loader reaches the Workspace only through
  `WorkspaceReadsV1`/`WorkspaceFilesV1`; it holds no Computer type and makes no
  Computer call. `packages/plugin-shell/src/backend-skills.ts` is the Durable
  Object's half: it builds the host from a `WORKSPACE_FILES` binding and
  returns `undefined` when that binding is absent, so the Package is simply not
  mounted rather than reading instructions from a second store it invented.
  **That binding does not exist yet** — Step 1 owns the Workspace file surface
  and Step 3 owns the durable-root sync that backs it from object storage — so
  no production Turn loads a Skill until one of them lands.

**Quota, decided.** `plugin-authoring`'s `AuthoringQuotaConfigV1` does not fit:
its limits are artifact source size, retained _Composition_ generations, and a
daily authored-generation rate reserved in the User Durable Object against an
authoring `effectId`. A Skill produces no artifact and no Composition
generation, and reserving a daily unit for editing a Markdown file would lock a
Bot out of its own instruction root for the rest of the day. What bounds a
Skill is Workspace disk, so `packages/plugin-skills/src/quota.ts` declares two
limits — 200 Skills per Bot, 64 KiB per Skill — checked against what the root
already holds, which makes a resumed Turn that rewrites the same Skill free.
They live in the Package rather than in durable per-User configuration until
the durable-root sync exists to make Workspace disk measurable; that gap is
recorded in the **Open** list of `docs/architecture-checks.md`.

---

## Step 3 — Memory Package

**Goal.** The Memory Package is the single writer of Memory roots, writing
object storage directly, per ADR 0013. Memory works while the Computer is
hibernated.

**Consumes.** `WorkspaceMemoryRootV1` to name the two Memory roots;
`WorkspaceMemoryProjectionV1` for what the kernel and the Computer see;
`WorkspaceWriterV1` and `WorkspaceGenerationV1` for every write it records;
`workspaceRootAcceptsKernelWriteV1` for the refusal at the Workspace seam.

**Owns.** `packages/plugin-memory/src/*` (the object-storage writer, the
generation records in the owning Durable Object, conditional `If-Match`
writes and conflict preservation) and
`packages/plugin-shell/src/backend-memory.ts`.

**Does not own.** The rule that Memory contains no secrets and no credential
references — that is this Package's policy to enforce, and it is _only_ here:
`kernel-contracts` deliberately declares nothing about it, because the kernel's
file contract carries bytes and cannot classify them.

**Tests that gate.** Memory is readable and writable with no Computer interface
call; a Workspace write into a Memory root is rejected at runtime; conflicting
Workspace and object-storage writes to a non-Memory durable root both survive
as generations and are surfaced; indexes rebuild from the files.

### Parity facts

From `docs/research/grokbot-computer.md` (§4.1a–b, GrokBot's own injected
prompt and its harness renderers). These are observations about the system we
are matching, not a change to the Step 3 scope above; they are recorded here
because they bear on the Memory root layout this step lands.

- GrokBot has **three** memory scopes, not two: own (Bot), **project**, and
  user, in injected order user → project → own. AGENTS.md § Memory names only a
  Bot Memory root and a User Memory root, and `plugin-memory` today has tiers
  `agent` and `global` — no project tier, no membership.
- **User memory is sharded by writer**: `user-memory/by-agent/<agent-uuid>/`,
  one `profile.md` + `log/` per writing Bot, _"so every file has a single
  writer"_; a Bot corrects another's shared fact by writing the correction into
  its own shard, and newest wins. Project memory shards identically. Our
  `user-memory` root is currently one prefix per owner
  (`plugin-memory/src/scopes.ts`), so "writes are segregated by writer" in
  AGENTS.md is satisfied by generation records rather than by path.
- Precedence is own > project > user, newest-wins within a shared tier.
- What is injected is capped and then **frozen per compaction epoch**
  (`resolveFrozenMemoryPrompt`), which is GrokBot's own best explanation for
  own-profile facts sitting on disk and never reaching the prompt. AGENTS.md
  already requires the session event log to record exactly what was injected,
  _"so an injection gap is visible in durable state"_ — this is the concrete
  failure that rule is for.
- On-disk fact lines are `- (YYYY-MM-DD) <fact>`; injected lines are
  `- (learned YYYY-MM-DD) [via <assistant>] <fact>`. Notes and episodes are a
  `[note] ` / `[episode] ` prefix on the fact text, not separate files.

---

## Parallelism and the one shared file

Steps 1, 2, and 3 are independent given Step 0. They touch exactly one file in
common: `docs/architecture-checks.md`, where each step adds its own rows and
removes its own entry from the **Open** list. Append rows in step order (1, 2, 3) to keep the conflict trivial when two land close together.

Step 2 and Step 3 both read Workspace files, and neither writes through the
other's surface: the Skills loader is read-only, the Memory Package writes only
Memory roots. Step 1 is the only step that changes `computer-core`.

---

## What could go wrong

- **`ComputerTarget` retirement lands mid-flight.** Step 1 removes the
  deprecated alias; Steps 2 and 3 must not reference it. They consume
  `kernel-contracts` types only, so this holds by construction — check it in
  review rather than assuming it.
- **Two spellings of a root.** `ComputerWorkspace.openDirectory`'s
  `namespace` + `scope` pair and `WorkspaceRootV1` describe the same thing.
  Step 1 must delete the first, not adapt between them, or Step 3 will decode a
  root two ways.
- **The Skills `todo` converted too early.** It is a real test only once a
  loader exists; converting it in Step 0 or 1 makes the check pass against
  nothing.
