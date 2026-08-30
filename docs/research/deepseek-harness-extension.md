# Research: DeepSeek Harness self-modification, plugins, and tools

## Summary

DeepSeek Harness does not have one self-modification feature; it has four separate mechanisms with different lifetimes, authorities, and audit properties, and only one of them is what the existing runtime note guessed at.

1. **Dynamic Cordis Packages** — the model authors plain JavaScript through seven `cordis_*` tools, the host evaluates it in a `node:vm` realm, and it becomes a live Cordis plugin that can register model-visible tools, services, event listeners, and browser UI. Versioned, immutable per package, disposable, and held **entirely in process memory**. There is no save, promote, or install path.
2. **Agent presets** — a durable, on-disk, per-session composition (`agent.cordis.yml`) that an agent can copy and then edit with ordinary filesystem tools. This is the persistent axis, and it survives restart.
3. **Profile patch layers** — `cordis.patch.yml` documents in the Harness home that the shipped `web` profile watches and live-recomposes on a valid edit.
4. **Skills** — an agent that writes a `SKILL.md` under a scanned root sees it in its own catalog on the next step, because the first-party `write`/`edit` tools invalidate the skill provider synchronously.

The existing runtime note's finding 8 refers to a "runtime patch tree". That phrase appears once in the repository, in `packages/bundle/README.md`, describing `sdk-minimal` supplying its **complete patch tree** as one bundle layer. It is profile/bundle composition vocabulary, not an agent-writable artefact. The correction matters: DeepSeek's actual runtime-extension surface is richer and more dangerous than that phrase implies, and FrockBot should design against the real thing.

FrockBot should copy the identity model (stable Plugin, immutable Packages, `current`/`next` pointers, repair-by-append), the guarded registration boundary that validates model-written schemas where they are written, the fiber-disposal teardown contract, and the inspect-before-you-write catalog. FrockBot should **not** copy the authority model: a host-half dynamic package runs with the harness's full authority under a process-global fiber group with **no human approval at all**, approval gates only the browser half, and that approval never reaches the session log.

> **Evidence baseline.** All source links are first-party `deepseek-ai/deepseek-harness` permalinks at commit [`0a53fb55`](https://github.com/deepseek-ai/deepseek-harness/commit/0a53fb55bea101816fa226bb964ae2bed71c343b). The pi section is pinned to `earendil-works/pi` commit `853a80d`. No third-party commentary is used.

## Findings

### Self-modification and runtime extension

1. **Correct the record: the "runtime patch tree" is a composition layer, not a self-modification tree (positive, high).** `packages/bundle/README.md` maps the installable **patch layers** used by `dsh --profile`: each bundle package declares `dsh.bundle.patch`, the launcher stacks those patch documents to assemble a named profile, and `sdk-minimal` is called out as the exception that "supplies its complete tree in one bundle" (the row reads "complete patch tree"). `docs/architecture.md` gives the stacking order — each bundle in listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay — and states that a patch targets a row by id and replaces its whole config, or inserts new rows. Nothing in that machinery is written by an agent. For FrockBot, drop the "runtime patch tree" phrasing from the constitution amendment and replace it with the two real axes below: an in-memory dynamic-Package registry and a durable composition document. [Bundle group](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/README.md) (`packages/bundle/README.md`) · [Profiles and bundles](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/architecture.md) (`docs/architecture.md`)

2. **Copy the Plugin/Package identity model and repair-by-append (positive, critical).** `packages/extensions/README.md` states the group's purpose plainly: "The extensions group lets a running agent modify the runtime it runs inside." The vocabulary is three-level. A **Plugin** is a stable identity that evolves over time; a **Package** is one immutable Host/Client source version under it; a **pluginRunId** is one activation attempt that ties together approval, host/client loading, private RPC, the run card, and errors. Two pointers carry state: `currentPackageId` is the most recent fully successful Package, `nextPackageId` is the target awaiting approval, being attempted, or most recently failed. `cordis_define` mints identities and records source but "does not request approval, execute apply, or change currentPackageId"; `cordis_run` takes `mode: "run"` (first activation, restart, or **rollback**) or `mode: "update"` (switch versions). The model never overwrites a version — after a failure it reads diagnostics with `cordis_inspect_self`, appends a corrected Package to the _same_ Plugin, and updates to it. For FrockBot, adopt exactly this shape: an opaque Bot-scoped Package identity holding an append-only list of immutable Versions, with durable `currentVersionId`/`targetVersionId` pointers, so "roll back" is just running the current pointer again. [Extensions group](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/README.md) (`packages/extensions/README.md`) · [`src/prompt.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/tool-cordis/src/prompt.ts) · [Tool catalog — `cordis_define`/`cordis_run`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/tool-catalog.md) (`docs/tool-catalog.md`) · [`src/registry.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src/registry.ts#L49-L70)

3. **The seven tools, and what each does (positive, high).** `packages/extensions/tool-cordis/README.md` enumerates them: three read-only — `cordis_inspect_list` (the Host and Client Inspect Providers and their query methods), `cordis_inspect_query` (exact service methods, event modes, builtin signatures, tool schemas, theme tokens, live slot trees), `cordis_inspect_self` (this session's Plugins, version pointers, latest run, and — only when both `pluginId` and `packageId` are given — the Package source and runtime diagnostics) — and four lifecycle: `cordis_define`, `cordis_run`, `cordis_stop` (retract the live run, keep every version and grant), `cordis_undefine` (stop and permanently forget the Plugin and all Packages). The workflow the system prompt teaches is: inspect → define → run → handle the asynchronous outcome. Crucially, the inspect data is served from a **generated** API catalog (`src/api-catalog.ts`, regenerated by `pnpm run gen-cordis-api`, freshness-gated by `verify-cordis-api`) intersected with the live runtime, so a JSDoc or signature edit cannot ship without regenerating the catalog the model reads. For FrockBot, the lesson is that self-authoring is unusable without a machine-generated, freshness-gated contract catalog the Bot can query before it writes — hand-maintained API tables for the model were tried and rejected here. [Tool package](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/tool-cordis/README.md) (`packages/extensions/tool-cordis/README.md`) · [Self-referential toolset note](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)

4. **Do not copy the authority model: host halves run unapproved with full runtime authority (risk, critical).** The asymmetry is explicit. `packages/extensions/cordis-host-runner/README.md`: "A package with only a host half activates directly in this process: its code runs in the sandbox. A package with a browser half becomes a request: it waits until a person allows or declines it on a page." So the half that can register model-visible tools, call `ctx.shell`, `ctx.fs`, and `ctx.web`, and listen on the agent's own waterfalls, needs **no human decision at any point**. The same README states the trust stance without hedging: "The sandbox isolates globals but is not a security boundary… yet the services it declares reach the live runtime. Treat a dynamic package like bash access." The `sandbox.ts` module header repeats it: "This keeps cooperative packages inspectable and disposable but is not containment: host-realm helper functions remain an escape route." And the process sandbox seam does not apply — `docs/subsystems/sandbox.md` confines _subprocess argv_ under a file-effect policy, so in-process vm code is outside it entirely. What gating exists is compositional, not runtime: the tool catalog records that `dsh-tool-cordis` is "Not in any shipped tree (a deliberate opt-in)", the `web-app` bundle mounts the runners and browser faces but not the toolset, and the model only gets the tools if a person selects the shipped `cordis` agent preset, whose own header says "Treat a session on this preset as shell access." For FrockBot, this is the single most important thing **not** to copy. A Bot that authors its own Package must run it under a declared, enforced capability grant — not the harness's ambient authority — and the grant decision must be a durable, authenticated command, not a composition choice made once at deploy time. [Host runner](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/README.md) (`packages/extensions/cordis-host-runner/README.md`) · [`src/sandbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src/sandbox.ts#L1-L12) · [Process Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/sandbox.md) (`docs/subsystems/sandbox.md`) · [`presets/cordis/agent.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/presets/cordis/agent.cordis.yml)

5. **The browser-half approval is real but undurable, and is not the general approval seam (risk, high).** DeepSeek has a proper approval subsystem — `ctx.approval` with a closed fail-closed `ApprovalOutcome`, a per-session `ask`/`never` policy, and a logged `approval/asked`/`approval/decided` audit pair (`docs/subsystems/approval.md`). The dynamic-package flow does not use it. `cordis-host-runner/src/types.ts` declares its **own** `ApprovalRequestId` brand, and the grant state lives in the in-memory registry as `approvedClientPackages: Set<CordisDynamicPackageId>` plus a plugin-wide `clientVersionUpdatesApproved: boolean` (the "double check mark" that authorizes future versions of the same Plugin). `packages/extensions/ui-cordis/README.md` says the quiet part outright: the panel "deliberately leaves no session-log trace of a person approving, declining, running, or stopping anything." Approvals are also frame-wide — any open page may answer any request, first answer wins — and a suspended request has no timeout, so a headless or ACP deployment holds a browser-half run until the asking turn is cancelled. For FrockBot, invert all of this: the approval decision for mounting a Bot-authored Package must be a durable, authenticated, replayable event in the Bot's log, scoped to an identified principal, with an explicit expiry, and it must gate the _authority-bearing_ half rather than the presentation half. [User Approval](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/approval.md) (`docs/subsystems/approval.md`) · [`src/registry.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src/registry.ts#L49-L70) · [UI package](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/ui-cordis/README.md) (`packages/extensions/ui-cordis/README.md`)

6. **Copy the failure and teardown contract; it is genuinely good (positive, critical).** Four layers of it. **(a) Define-time**: `cordis_define` "prechecks each half's syntax by compiling it (running nothing)", so unparseable code is refused before an id exists. **(b) Registration-time**: `src/guard.ts` is a registration boundary, not a sandbox — it rebuilds vm-realm tool schemas and canonical values as host objects, normalizes unambiguous JSON-Schema spellings, rejects invalid vocabulary with a teaching error naming the accepted alternatives, hands `apply` a whitelist context façade rather than a real `Context`, and requires a declared `inject` before a service is readable. A malformed tool schema therefore fails at registration, not later during prompt assembly. **(c) Start-time**: `src/lifecycle.ts` starts each host half as a child under one `cordis-dynamic` group fiber, awaits settlement, and **disposes the fiber before rethrowing** any startup failure, "so a failed run never lingers"; a valid-but-unresolved `inject` legitimately stays pending and the missing service names are reported. **(d) Post-settle**: a browser half that loads cleanly can still throw during React render, and that crash arrives _after_ the run was answered, so the client runner reports it to the host with the slot and whether the entry was retired, the host retains the last one per package, steers the owning session with it, and exposes it through `cordis_inspect_self`. Throughout, teardown is ordinary Cordis effect unwinding — "everything the plugin registered is an effect on its fiber" — so `cordis_stop` is one awaited `fiber.dispose()`. For FrockBot, this is the model to follow: validate the model's declared surface at the registration boundary in the host realm, never leave a half-started Version mounted, and give the Bot a machine-readable diagnostic it can act on without a human. [Host runner](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/README.md) · [`src/guard.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src/guard.ts#L1-L14) · [`src/lifecycle.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src/lifecycle.ts#L1-L44) · [Client runner](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-client-runner/README.md) (`packages/extensions/cordis-client-runner/README.md`)

7. **Do not copy the storage model: definitions are process memory and there is no promote path (risk, critical).** Stated identically in three places. `packages/extensions/README.md`: "Definitions live only in process memory, so a DSH restart clears them and nothing here writes repository files or configuration." `tool-cordis/README.md`: "nothing here writes repository files, installs packages, or changes `cordis.yml`", and definitions are **session-scoped** — visible and controllable only in the session that defined them, read as absent by other sessions. The design note is explicit that this was a decision, not an omission: temporary Plugins "create no Plugin file, install no package, change no `cordis.yml` or personal/project configuration, do not survive restart, and have no automatic save, promote, or install path. Keeping an experiment means asking the Agent to implement a normal project Plugin… through the regular development workflow." Session resume rehydrates conversation history but never recreates them. For FrockBot the constraint is inverted by the platform: a Durable Object is evicted routinely, so an in-memory-only Package registry is not merely lossy, it is the _normal_ case. FrockBot must make the authored Package durable in DO storage at define time and treat mounting as a derived, re-executable step on every wake. [Extensions group](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/README.md) · [Tool package](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/tool-cordis/README.md) · [Self-referential toolset note](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)

8. **Provenance exists, but only as a by-product of the logging invariant (positive with caveat, high).** `AGENTS.md` states the constitutional rule: "**Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event", and `docs/architecture.md` says a runtime invariant asserts it. So the define call's arguments — including the submitted source — and its receipt sit in the log as an ordinary `tool/call`/`tool/result` pair, and when a running package changes the tool set, the loop appends a full `request/header` snapshot with reason `change`. That header carries the call config, the rendered system prompt, and **the assembled tool schemas**, so the exact model-facing surface a dynamic package added is reconstructable, and "every conversation request is a pure function of the log". What does _not_ exist is a dedicated audit event: a `cordis/mount` session event was explicitly considered and rejected as duplicating the `tool/call`/`tool/result` pair and the changed header. The consequence is that you can answer "which turn produced this tool" only by reading tool-call history, and the human's approve/decline decision is not recorded at all (finding 5). For FrockBot, keep the logging invariant, and add the dedicated event DeepSeek declined: a `package/defined`, `package/mounted`, `package/retracted` triple carrying Package id, Version id, authoring turn, granted capabilities, and approver identity. [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/AGENTS.md) · [Session log](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/architecture.md) (`docs/architecture.md`) · [The request header event](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/session.md) (`docs/subsystems/session.md`) · [Self-referential toolset note — alternatives considered](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)

9. **The durable self-modification axis is agent presets, and it is the closest analogue to FrockBot Packages (positive, critical).** `packages/preset/agent-presets/README.md`: a preset is "a directory holding a single `agent.cordis.yml` that names the plugins the session runs with… A session that names a preset gets that preset's tools, prompt sections, and skills, while every other session keeps its own, so one process can run several differently composed agents at once." Presets come from ranked roots each carrying a `trust` level (`system` for the shipped set, `user` for authored ones), plus `<dshHome>/.agent-presets`. **Authoring is copy-only**: `copy(from, id, name?)` duplicates an existing preset's whole directory — composition, display metadata, skill directories, assets — into the first `user` root, "so no caller supplies composition text and a copy grants nothing the roster did not already carry"; after that, everything happens in the preset's own files, which the agent edits with ordinary `write`/`edit` tools. The shipped `cordis` preset's persona instructs exactly that, names the two planes an edit belongs to (host composition vs agent preset), and forbids editing the shipped install because "an upgrade overwrites it, and corrupting the `cordis` preset would disable this very mode." Reload semantics: the mount records the composition file's mtime+size stamp, a session finding the stamp stale starts the **next generation**, and sessions already joined keep the generation they run on — so a running session outlives its file changing or disappearing. A session may switch preset only while it has produced nothing, and the committed switch is recorded in the session log as `agent-preset/selected` so a resumed or forked session rebuilds under the composition it ran. For FrockBot, this is the direct template for a durable Bot-authored Package: copy-from-template authoring rather than free-text composition, an explicit trust root, generation-per-file-stamp instead of live mutation of a running instance, and a logged selection event so recovery rebuilds the right composition. [Agent presets](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/README.md) (`packages/preset/agent-presets/README.md`) · [`presets/cordis/agent.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/presets/cordis/agent.cordis.yml) · [`skills/editing-cordis-compositions/SKILL.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md)

10. **Preset composition fails closed and is audited before it can start a session (positive, high).** A preset whose composition is missing, unparsable, not a list of named plugin rows, or naming an unresolvable module is listed as **broken with a reason naming the rows at fault**, and composing it is refused up front "so a session never starts half-composed". A row that loads and then refuses — throwing on apply, or waiting forever for a service the composition never supplies — fails session creation and rolls it back, naming every failed row including those inside a group. Beyond that, `mountPreset` runs its own audit because a directly-plugged subtree is absent from `ctx.loader.entries()` and no boot audit covers it; it rejects an unscoped target (the preset's tools would register globally), a row still waiting on an unsupplied service, and a row that published a service into the root realm (process-global, so a second preset publishing the same name collides). An invariant companion re-checks that last rule on every service notification, because a row publishing from a timer would escape the one-shot audit. Health has an honest limit, stated as such: discovery "asks what is installed, not what would import" — it never imports a module, so a package with a missing entry file, a plugin that throws on apply, and one waiting forever all still fail at the first session. For FrockBot, copy the three-stage shape: static validation at author time, a mount audit that proves the result usable before any session joins it, and a continuous invariant for the rules a one-shot audit can miss. [Agent presets](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/README.md)

11. **Profile patch layers give a third axis with real hot reload and a real rollback (positive with risk, medium).** `packages/boot/app-boot/README.md`: a profile lives at `$DSH_HOME/profiles/<name>`, combines installable bundles, its own `cordis.patch.yml`, and a `patchReload: live | startup` policy; profiles with `patchReload: live` "watch both user patch files: a valid edit recomposes without restart, while a rejected edit leaves the last good app running." The shipped `web` template is live; `headless`, `sdk`, `sdk-minimal`, and `acp` apply patches only at startup, because "replacing a one-shot or stdio application's dependencies after it owns work would invalidate that lifecycle". Packages install per profile through `dsh plugin --profile <name> <pnpm args>`, which forwards to pnpm in the profile directory. Module-level HMR also exists — `@deepseek-ai/cordis-plugin-hmr` watches files and unload/reloads the changed plugin — but `dsh-base` ships it `disabled: true` with the comment "Module reload is opt-in per profile." For FrockBot, take the rejected-edit semantics: a bad composition must leave the previously-good runtime serving, never a half-applied one. Note also the profile split — the surfaces that own in-flight work refuse live recomposition, which is the same reason a Bot DO must not swap Contributions mid-Turn. [app-boot](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/boot/app-boot/README.md) (`packages/boot/app-boot/README.md`) · [`packages/bundle/base/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/base/cordis.patch.yml#L19-L26) · [dsh CLI](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/apps/cli/README.md) (`apps/cli/README.md`)

12. **An agent that writes a `SKILL.md` sees it on its own next step (positive, high).** `packages/skill/skill-filesystem/README.md`: existing roots are watched by Chokidar and a catalog refresh reaches the next model step, but more importantly "The first-party `write` and `edit` tools invalidate the provider directly when their target could affect a watched skill, so the model observes its own filesystem mutation without waiting for the host watcher." That is a complete, durable, restart-surviving self-extension loop for _instructions_ — no vm, no approval, no restart — and it is the cheapest one in the system. For FrockBot, the analogue is Bot-authored instruction documents in DO storage with synchronous catalog invalidation, and it is worth shipping before Bot-authored code. [skill-filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/skill/skill-filesystem/README.md) (`packages/skill/skill-filesystem/README.md`)

### Plugin system

13. **A plugin's "manifest" is two documents, and only one is a manifest (positive, high).** The **composition entry** is a row in a `cordis.yml` / `cordis.patch.yml`: `id` (stable, so the loader diffs an edit rather than treating it as remove+add), `name` (module specifier), `config`, `disabled`, plus `inject` and group/`isolate` nesting. Row order carries no load semantics — activation is service-availability driven. `!!js` expressions are permitted only inside `config` and `disabled`. The **package.json** carries a repo-specific `dsh` field: `dsh.client` marks a browser half (`{ inject: [<package names>], platform: "web", … }`, scanned by `ctx.clientModules` to build the boot graph), `dsh.bundle.patch` points at a bundle's patch file, and `dsh.profile` lists a profile's bundles. Config validation uses any Standard Schema validator exported as `Config`; this repo uses Schemastery, and invalid config puts the fiber in FAILED with a `ValidationError` **before** `apply` runs. Export subpaths are conventional: `.`, `./invariant` (mandatory per-package invariant companion), `./client` (browser half), `./types` (client-safe payloads), `./typert` + `./remote` (generated Host/Client halves of a Typert Remote). For FrockBot, note that there is no single self-describing manifest: identity/build metadata and composition are deliberately separate documents, and the composition document is the user-editable one. [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-primer.md) · [Composition and HMR](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-tutorial/06-composition-and-hmr.md) · [Adding a package](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cookbook/adding-a-package.md) · [Client modules](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/client-modules.md)

14. **Copy the fiber lifecycle and effect-unwinding contract wholesale (positive, critical).** A plugin is a function, an object with `apply`, or a `Service` subclass. A **fiber** is one loaded plugin instance with states `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`, plus `FAILED` off LOADING, and a handle exposing `state`, `config`, `dispose()`, `restart()`, `update(config)`, `getEffects()`. Teardown is not a `dispose` method a plugin author remembers to write — it is **effect unwinding**: `ctx.effect(execute, label?)` runs immediately, collects disposers, and runs them in reverse order on unload or on the returned disposer, whichever comes first; double-dispose is a no-op. `ctx.on`, `ctx.plugin`, service registrations, and registry registrations such as `ctx.tools.register` are already effects. One documented caveat: multiple **async** disposers run concurrently, so sequence-sensitive teardown must live in one disposer. Dependency ordering is `inject` and nothing else — a plugin stays PENDING until every listed service exists, and PENDING is silent, which the tutorial names as the standard "my plugin does nothing" diagnosis; optional dependencies are read with `ctx.get('name')` and an undefined check. Dependencies are tracked after load, so if a provider unloads every dependent unloads and reloads when it returns. For FrockBot, this is exactly the seam that makes `cordis_stop` a one-liner and makes broken-Package rollback safe. A FrockBot Contribution must likewise register only through effect-returning APIs so that retracting a Version is a single disposal, and unresolved dependencies must be an observable pending state with named missing services, never a silent no-op. [Lifecycle and effects](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-tutorial/02-lifecycle-and-effects.md) · [Fiber API](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-api/fiber.md) · [Services](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-tutorial/03-services.md)

15. **What a plugin can register, and the `ctx` service model (positive, high).** `docs/architecture.md` keeps a "Where new behavior goes" table: model provider → `ctx.llm`; model-facing capability → `ctx.tools`; a different capability set for one session → an agent preset; shell → a `ctx.shell` backend; human command → `ctx.commands`; background work → `ctx.jobs`; externally-started session → `ctx.webhookRuntime`; filesystem access or policy → a `ctx.fs` provider or the `fs/*` events; interception → an `agent/*` or `tools/*` event. Browser halves additionally register UI through `ctx.slots.register({name, id, order, children, store, inject}, Component)`. System-prompt sections register on `ctx.systemPrompt` with an order, and scoped sections shadow global ones. There are roughly seventy `ctx` keys documented across `docs/subsystems/`. The service model itself: a `Service` subclass calls `super(ctx, 'name')` and is removed with its owning fiber; low-level `ctx.provide(name, value)` is owned by the current fiber and throws on a duplicate in scope; only the providing fiber may `ctx.set`; `ctx.get(name)` in strict mode returns only implementations whose providing fiber is active. Service names are one flat namespace per app. Events have five dispatch modes declared as part of the public contract via an `@mode` tag — `emit`, `waterfall`, `parallel`, `serial`, `bail` — and a waterfall is around-middleware: a listener that returns without calling `next()` short-circuits the chain. For FrockBot, keep the "one documented extension point per kind of behavior" discipline and the declared dispatch mode; note especially that a Bot-authored waterfall listener that forgets `next()` can silently stop the Bot's own tool dispatch, which the toolset warns the model about directly. [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/architecture.md) · [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-primer.md) · [Context API](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-api/context.md) · [Slots](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/slots.md)

16. **Plugin isolation is visibility, not security — and DeepSeek says so (risk, critical).** Every plugin runs in one process on one shared `ctx`. Three visibility mechanisms exist: `ctx.isolate(name, label?)` gives a subtree its own service scope for one name; agent presets compose sessions behind `isolate` realms that are invisible outside the declaring group, including to the host, readable only through `agentPresets.serviceForAgent(...)`; and `dsh-scope` provides the per-agent primitive (`createScope`, `scopeOf`, `scopeTarget`) that composes `Context.filter` so untagged listeners stay global while tagged ones see their key and descendants. The critical caveat is stated in the scope README: "**Only scope-aware APIs isolate state**" — an ordinary service stays context-global even when called through a scoped context. Trust is metadata, not enforcement: preset roots carry `trust: system|user`, and the README says "a preset is as privileged as the plugins it names… the same trust as shell access". For FrockBot, do not mistake scoping for sandboxing. If two Packages on one Bot must not read each other's state, that has to be an enforced boundary — separate isolates, capability-scoped handles, or a separate execution context — not a naming convention. [Scope](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/core/scope/README.md) (`packages/core/scope/README.md`) · [Context API](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-api/context.md) · [Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/core.md)

### Tool system

17. **Copy the tool definition contract: a canonical value, a mandatory output declaration, and pure presenters (positive, critical).** `defineTool({ name, description, parameters, output, execute, timeoutMs?, isConcurrencySafe?, presentCall?, presentResult? })`, registered with `ctx.tools.register(definition)`, which returns the exact disposer. Parameters use a bespoke JSON-value DSL (`ParameterSchemaSpec`/`ValueSchemaSpec`) compiled to an enforced JSON-Schema subset that is the wire form shared with MCP, subagents, and workflows — not zod, and not the Typert layer used for Host↔Client RPC. `output` is **mandatory**: `{ schema, render(args, value), presentationMeta? }`, and `execute` returns only the canonical JSON value; the human- and model-facing content is rendered from it. The registry's `schemas()` builds the model-facing view by an explicit allowlist so `output`/`execute`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` can never leak into a request. `presentCall`/`presentResult` return `card`-tagged view unions and must be **pure**, because they run both on live streaming and on session-log replay — no I/O, no clock, no session reads — and `defineTool` soft-validates them, returning `undefined` rather than throwing on malformed logged args. For FrockBot, adopt the canonical-value/rendered-view split and the replay-purity rule directly: it is what lets a transcript re-render identically years later, which a DO-backed Bot needs even more than a local process does. [Tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/tools.md) (`docs/subsystems/tools.md`) · [Adding a tool](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cookbook/adding-a-tool.md)

18. **Copy the four-stage execution pipeline and its ordering invariant (positive, critical).** `ctx.tools.execute(exec)` freezes lossless-JSON args and mints an opaque `exec.token`, then runs: `tools/pre-execute` (waterfall, returns `allow | deny{reason} | ask{reason?}`; an `ask` is routed by the registry to `ctx.approval`) → **monotonic guards** registered via `ctx.tools.guard()`, which are deny-only so a later listener cannot undo an earlier denial → `tools/execute` (around-dispatch waterfall: timeouts, retries, metrics) → the body → `tools/post-execute` (waterfall, returns `accept{content|value}` or `block{feedback}`) → normalization → the definition's `finalizeContent` → `tools/result` (emit). The ordering is asserted by a runtime invariant. All `tools/*` execution events are scope-filtered by `exec.agent`. Cancellation is not optional: a `signal: AbortSignal` is required on every input, a `tools/execute` wrapper may replace it but never remove it, and the registry re-fuses the caller's signal before the body; failure codes distinguish `TOOL_ABORTED_BEFORE_DISPATCH` from `ABORTED`. `timeoutMs` is **declarative only** — enforcement is a separate `timeout-policy` wrapper plugin. Concurrency is fail-closed: `ctx.tools.executionMode(exec)` opts a call into parallelism only on an exact `true` from `isConcurrencySafe(args)`, and the loop builds exclusive barriers and a rolling pool capped by `maxParallelToolCalls` (default 10). For FrockBot, this is the right decomposition: a Bot-authored Package registers into named pipeline stages rather than being trusted to police itself, and deny-only guards give the platform a place to stand that no Contribution can override. [Tool execution pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/tool-execution-pipeline.md) (`docs/tool-execution-pipeline.md`) · [Tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/tools.md)

19. **The result vocabulary has steering but no side-effect classification (positive with gap, high).** `ToolExecutionResult` is a closed `Success | Failure` union. Success carries `isError: false`, an execution-local canonical `value: JsonValue` that is **never persisted**, a `content: ContentBlock[]`, optional `meta`, optional `additionalContexts: UserMessage[]`, and optional `concludesTurn?: true`; Failure carries a `ToolFailure { message, info?{name, code} }` and no `value`. Steering is a first-class idea with three carriers: `additionalContexts` on the result, `ToolRunContext.deferContext(userMessage)`/`concludeTurn()` during execution, and `exec.agent.inject({content, source})` for context the _next_ request sees. Model visibility is controlled per agent by `ctx.tools.restrict({allow, deny})` with intersecting masks, and by `ToolPresentationMode = 'native' | 'ptc' | 'both'` — under `ptc` the only announced tool is a reserved `run_code` transport plus a generated TypeScript/Python SDK, and direct calls to other tools fail `UNKNOWN_TOOL` before policy. What is **absent** is any side-effect classification: the nearest analogues are `isConcurrencySafe` (mutation safety) and the presentation-only `ToolCallKind = read | edit | delete | move | search | execute | fetch | other`. For FrockBot, adopt the steering vocabulary — it is exactly how the dynamic-package runner reports asynchronous run outcomes back to the model — but add the missing piece: a declared, enforced effect class per tool, because a Bot DO must know before dispatch whether a call is externally observable and therefore needs durable intent and an idempotency key. [Tools subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/tools.md)

20. **Approval and sandboxing are separate, layered, and fail-closed — and neither covers in-process code (positive with risk, critical).** `ctx.approval.request(req)` is the one-shot human gate: outcomes are `allowed-once | rejected | cancelled | unavailable`, callers deny on anything but `allowed-once`, and a missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate. A per-session `ApprovalPolicy` of `never` is enforced _inside_ the service before waterfall dispatch, so an answerer registered later with `prepend` cannot bypass it. A tool never calls approval itself: a `tools/pre-execute` listener returns `{kind: 'ask'}` and the registry routes it. `ctx.permissionPresets` bundles two independent knobs — sandbox mode and approval policy — as `workspace-write` (workspace-write + ask) and `danger-full-access` (danger-full-access + never), with `custom` a derived-only state that is never a switch target; the preset service enforces nothing itself. `ctx.sandbox.confine(argv, policy)` returns a `ConfinedArgv` carrying `enforcement: full | partial` plus denial signatures, and silent unconfined passthrough is illegal (`SANDBOX_UNAVAILABLE`). Backends are Linux bwrap/Landlock, macOS Seatbelt, and a Windows ACL restricted token that always reports `partial`. Modes govern **file effects only** — "Network and process visibility are outside this vocabulary" — and the confinement applies to spawned subprocesses plus, separately, filesystem writes through the swap-in `fs-sandbox` backend. **In-process tool bodies are not sandboxed**, which is precisely the hole a dynamic Cordis package occupies. For FrockBot, the layering is right and worth copying — policy resolution, a fail-closed gate, and enforcement as separate concerns — but the enforcement backend must be the platform's own isolation, not an in-process façade. [User Approval](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/approval.md) · [Permission presets](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/permission-presets.md) · [Process Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/sandbox.md) · [sandbox-local](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/sandbox/sandbox-local/README.md)

### Memory

21. **There is no memory subsystem; "memory" is an optional MCP server, off by default (risk, medium).** There is no `packages/memory`, no `ctx.memory`, and no memory subsystem page. `docs/user/guide/mcp-memory.md` documents three _reference configurations_ — Memorix, `@modelcontextprotocol/server-memory`, and Engram — bridged through `@deepseek-ai/dsh-mcp-client` and exposed as ordinary `mcp__<server>__<tool>` tools, and states that no memory server is present in the shipped composition, so omitting the `--patch` keeps all three disabled. DeepSeek owns no storage, embeddings, summarization, or forgetting policy, and injection into context is entirely by tool calls the model chooses to make. What DeepSeek _does_ own is all session-scoped: the log is the source of truth, compaction is lossy summarization within a session (a `compaction/summary` event plus a `user/message` with `surfaceOp: {op: 'replace'}`), goals are titled "Same-session goals", todos are per-session whole-list last-write-wins, and spill persists oversized tool output to session-scoped files behind a locator. Two things approximate cross-session recall: **session references** (a user writes `@[label](dsh-session:…)` and DeepSeek prepares an aggregated _untrusted_ snapshot as `additionalContext`, with candidate filtering searching label/id/cwd and "never transcript text"), and the opt-in read-only `session_search` / `session_trace` / `session_event_*` tools authorized from the calling agent's workspace. The repo's own honest summary appears in the ralph tool's description: "the shared workspace is long-term memory" — i.e. the filesystem. For FrockBot, take the warning: a persistent Bot with no memory design will end up using its Package store as memory by accident. Decide deliberately whether Bot memory is a first-class durable projection or an explicitly-summoned tool, and keep cross-session material marked untrusted the way session references are. [MCP memory guide](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/user/guide/mcp-memory.md) (`docs/user/guide/mcp-memory.md`) · [Compaction](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/compaction.md) · [Session reference](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/session-reference.md) · [Spill](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/spill.md)

### Workspace, filesystem, shell

22. **One immutable cwd per session, no multi-root, and the workspace registry is invisible to the model (positive, high).** `SessionHeader.cwd` is immutable header metadata validated absolute at creation, forks inherit it, and tools derive their working directory from `exec.agent?.session.header.cwd`. `ctx.workspaceRegistry` is a host-side record of `{id, canonical path, title, sessionIds}` keyed by `fs.realpath`, and it is explicitly invisible to models — no tools, no prompt text, no session events. There is no multi-root concept; the only multi-path notion is the sandbox's `writableRoots() = [workspaceRoot, '/tmp', os.tmpdir()]`. `fs-local`'s `config.cwd` is documented as a resolution default, **not** containment. For FrockBot, an immutable per-Session root plus a separate host-side registry maps cleanly onto a Sprite workspace bound at Session creation; resist making the working root mutable mid-Session, since every logged tool call is interpreted relative to it. [Workspaces](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/workspace.md) (`docs/subsystems/workspace.md`) · [Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/persistence.md) · [fs-local](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/fs/fs-local/README.md)

23. **Copy the filesystem CAS and the separable read-before-write policy (positive, high).** The `ctx.fs` provider contract resolves a path to an opaque `FsTarget {targetKey, displayPath}`, and staleness is an opaque `FsVersion` compare-and-swap: an `FsWriteIntent` is either `createIfAbsent` (failing `FS_NOT_OBSERVED`) or `replaceIfVersion` (failing `FS_STALE_VERSION`), while `editText` is a provider-level atomic check-version-then-match-then-write. Local writes are temp-file + fsync + rename under a per-target FIFO lock, UTF-8 strict (`FS_NOT_TEXT` otherwise), LF-normalized as the diff basis with CRLF style restored on write. Notably, **read-before-write is not baked into the tools**: it is a separate optional plugin, `dsh-fs-observation-policy`, that registers no service and gates the `fs/write-intent` and `fs/edit-intent` waterfalls off a `WeakMap` of `fs/observed` records — the tool catalog notes a deployment loading the fs tools "is expected to also load it". Shell is a separate seam: `ctx.shell` with local and sandboxed providers, where **every call is a fresh `bash -c` process** — no persistence, no PTY, pass `workdir` rather than `cd` — with 120s default timeout (600s cap), 64KB/stream in memory before a 64MiB spill, and orthogonal `exitCode`/`signal`/`timedOut`/`aborted` outcomes where a nonzero exit is a result, not an error. A separate `ctx.terminals` PTY seam backs the persistent bash tool with one owner-scoped shell, a serialized queue, marker-anchored output, and reset-never-repair. For FrockBot, the CAS-on-version contract and the "policy is a plugin, not a tool feature" split are both directly transferable, and the fresh-process-per-call shape matches a Sprite exec model better than a long-lived PTY does. [Filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/filesystem.md) (`docs/subsystems/filesystem.md`) · [Shell](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/shell.md) (`docs/subsystems/shell.md`) · [Terminal](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/terminal.md)

### Skills and instruction files

24. **Skills are a ranked-root, progressively-disclosed catalog; AGENTS.md is a separate plugin (positive, high).** A skill is `<name>/SKILL.md` (bundle) or `<name>.md` (flat) at the **top level** of a scanned root — nested `**/SKILL.md` is deliberately not discovered — with YAML frontmatter requiring `name` and `description` and optionally `whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable`. Roots scan in rank order: `100 <projectRoot>/.dsh/skills`, `200 <projectRoot>/.agents/skills`, `300 Config.customSkillDirs`, `400 <dshHome>/skills`, `500 <agentsHome>/skills`, `600 bundled`, where the project root is the nearest `.git` ancestor probed _through `ctx.fs`_ so sandboxed and remote workspaces work. Disclosure has three levels: the tool injects a durable user-role system-reminder listing **name plus escaped description only** — no bodies, paths, or sources; `skill({name})` re-reads the current definition for the calling agent's cwd, rechecks policy, and returns `<skill_content>` plus `<skill_resources>` plus `<skill_instructions>`; and level three is explicit relative resources under `references/`, `scripts/`, `assets/`, never an enumerated directory. Catalog changes append a _full replacement_ catalog, digest-diffed. Separately, `@deepseek-ai/dsh-agent-instructions` loads `AGENTS.md` / `CLAUDE.md` at runtime: `.git` root marker, additive `.local` overlays, a user-global `$DSH_HOME/AGENTS.md`, a required `maxBytes`, and a first-request baseline assembled user-global → project chain root→cwd, broad-to-specific, with byte-identical siblings collapsed and broader files dropped before the most specific is truncated. There is **no watcher**: deeper, changed, or removed files surface on the next successful `read`/`write`/`edit` as "Additional instructions from: …" / "Instructions removed: …". For FrockBot, the ranked-root merge, the name+description-only first level, and the full-replacement catalog event are all worth copying; the lack of a watcher on instruction files is a deliberate cost DeepSeek pays for prompt-prefix stability, which matters to FrockBot's KV-cache economics too. [Skills](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/skills.md) (`docs/subsystems/skills.md`) · [tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/skill/tool-skill/README.md) · [agent-instructions](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/context/agent-instructions/README.md)

### Delegation, jobs, scheduling

25. **Delegation, background work, and reminders are three separate seams, and each has a durable identity (positive, medium).** **Subagent** (`ctx.subagents`) is the one capability seam where multiple named providers coexist — `spawn-in-process`, `fork-in-process`, `acp`, `codex`, `claude-code`, `dsh-sdk` — with two shapes: one-shot starts whose optional features (`agentOptions`, `outputSchema`, `maxDepth`, `toolFilter`, `persona`) are each gated by a static capability flag and rejected loudly with `UNSUPPORTED_CAPABILITY`, and continuable children where one durable child Session has at most one process-local Activation and `followup()` routes by residency. Depth is durable `SessionHeader.delegationDepth`, and discovery folds `subagent/descriptor` over sessions with header `origin: 'subagent'` **without resuming them**. **Jobs** (`ctx.jobs`) is the kind-agnostic background runtime: producers declare a `JobStart`, the runtime owns identity, authorization, and lifecycle, the producer owns resources; status is `running|stopping|completed|killed|failed` with a `reported` flag, access is fenced by owner session id, and `maxConcurrentJobsPerOwner` defaults to 10. **Schedule** is session-local durable reminders rather than cron: `after` / `at` / `every` (≥300s), canonicalized to RFC3339 UTC, with absolute input requiring an explicit offset or `time_zone` because "DSH never infers one"; authority is the versioned `schedule/change` event, a fork folds only to `seedLength` so it inherits history but no active reminders, and delivery waits for full agent idle and queues one `followup()` — never `steer()`, never mid-turn — at-least-once, skipping missed intervals. **Workflow** runs a model-written orchestration script in a `node:worker_threads` worker, starts all its children through the subagent seam, and never rejects: `stopReason` is `completed | cancelled | error`. For FrockBot, the schedule semantics are the closest thing here to DO alarms, and the "wait for idle, deliver as followup, never mid-turn, at-least-once with catch-up skipping" rule is exactly the contract a DO alarm handler should implement. [Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/subagent.md) · [Jobs](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/jobs.md) · [Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/schedule.md) · [Workflow](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/workflow.md)

### Profiles and bundles

26. **Five shipped profiles, four stacked on one shared base, and the self-modification tools are in none of them (positive, high).** `packages/boot/app-boot/src/profile.ts` holds the authoritative `PROFILE_TEMPLATES`, and a profile at runtime is a directory `$DSH_HOME/profiles/<name>/` whose `package.json` lists ordered `dsh.profile.bundles` beside a user `cordis.patch.yml`.

    | Profile               | Bundles                    | `patchReload` | What it is                                                           |
    | --------------------- | -------------------------- | ------------- | -------------------------------------------------------------------- |
    | `web`                 | `dsh-base`, `dsh-web-app`  | `live`        | Browser GUI: HTTP server, API gateway, ~40 `client/ui-*` packages    |
    | `headless`            | `dsh-base`, `dsh-headless` | `startup`     | One-shot task runner, no Host, no server, no browser plugin          |
    | `sdk`                 | `dsh-base`, `dsh-sdk-app`  | `startup`     | Stdio JSON-RPC server for the TS/Python SDK clients                  |
    | `acp`                 | `dsh-base`, `dsh-acp-app`  | `startup`     | Automation-only Agent Client Protocol server over stdio              |
    | `sdk-minimal`         | `dsh-sdk-minimal` only     | `startup`     | Standalone complete tree; deliberately does **not** stack `dsh-base` |
    | custom (`dsh plugin`) | `dsh-base`                 | `live`        | What a user-created profile starts from                              |

    `dsh-base` (~85 rows) carries everything the four base-backed profiles share: LLM adapters and retry, session/persistence/projection/query/telemetry/title, storage, settings, credentials, subprocess, the whole **sandbox** stack (`sandbox-local`, `sandbox-policy`, `bash-sandbox`, `pwsh-sandbox`, `fs-sandbox`), approval and permission presets, the **shell and filesystem tools**, the **skill** family, commands, goal, plan mode, compaction, subagent and delegation tools, workflow, spill, todo, web access, the tool registry, the system prompt, and the agent loop. It contains no HTTP server, no browser client, and **none of the extensions packages**. Only `web` mounts dynamic-cordis packages, and only three of the four — `cordis-host-runner`, `cordis-client-runner`, `ui-cordis`. `tool-cordis` appears in **no bundle patch at all**; it reaches a model only through the `cordis` agent preset or the checked-in example overlay. Two experimental profile bundles exist outside `PROFILE_TEMPLATES` (`agent-team-profile`, `agent-team-web-profile`) and are layered by hand in source checkouts. For FrockBot, note the shape of the gate: the runtime that _can_ mount agent-authored code ships in the GUI profile, but the tools that _let the model ask_ are withheld until a person picks a preset. That two-key arrangement is worth copying in spirit — capability present, authority separately granted — but FrockBot's second key must be a durable per-Bot grant, not a composition file. [`src/profile.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/boot/app-boot/src/profile.ts#L136-L165) · [`packages/bundle/base/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/base/cordis.patch.yml) · [`packages/bundle/web-app/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/web-app/cordis.patch.yml#L98-L222) · [`apps/cli/config/examples/cordis/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/apps/cli/config/examples/cordis/cordis.yml)

27. **The `web` profile moves tools out of the host plane and into agent presets — this is the two-plane doctrine made concrete (positive, critical).** `packages/bundle/web-app/cordis.patch.yml` **disables** the `dsh-base` host-plane rows for `tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`, `tool-fs-search`, `tool-str-replace-editor`, `skill-filesystem`, `tool-skill`, `command-goal`, `tool-goal`, `plan-mode`, `compaction-basic`, `command-compact`, `tool-result-pruner`, the `tool-subagent*` family, `workflow-worker-thread`, `tool-workflow`, `tool-ralph`, `agent-instructions`, `tool-todo`, and `tool-web`. They are not removed — they are re-mounted per session by the `standard`, `ptc`, `cordis`, and `minimal` agent presets. The _backends_ (sandbox, the skill registry, the `fs` and `shell` providers) stay host-plane, because a service with a consumer outside the agent plane cannot move into a preset. `headless`, `sdk`, and `acp` inherit all of it enabled from base with no preset layer. `sdk-minimal` is the outlier in the other direction: skills explicitly disabled (`skills: { enabled: false }`), no `tool-fs`/`tool-fs-search`, exactly two tools (a persistent shell plus `str_replace_editor`) on a bare `fs-local` with a `danger-full-access` sandbox policy. For FrockBot, this is the cleanest available statement of the boundary a Package system needs: **registries and anything crossing Sessions are platform-owned; what one Session contributes to those registries is Package-owned.** Write that sentence into the constitution. [`packages/bundle/web-app/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/web-app/cordis.patch.yml) · [`packages/bundle/sdk-minimal/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/sdk-minimal/cordis.patch.yml) · [`skills/editing-cordis-compositions/SKILL.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md)

## Process facts versus transferable principles

The brief asked for this separation explicitly, and it is worth being blunt about it.

**True only because DeepSeek is a long-lived Node process with a filesystem:**

- Dynamic Package definitions live in process memory and vanish on restart, with no promote path (finding 7). A DO is evicted as a matter of routine; "process memory" is not a lifetime FrockBot can offer.
- Host halves evaluate in a `node:vm` realm with Node-API traps. Workers has no `node:vm`; the equivalent isolation primitive is a separate isolate or a Sprite, which is a _stronger_ boundary than DeepSeek has, not a weaker one.
- The `cordis-dynamic` fiber group is process-global, so a dynamic package can affect other sessions in the same process. A Bot DO is already a per-Bot boundary, so FrockBot gets that isolation for free and should not give it back.
- Approval is answered by whichever browser page happens to be open, frame-wide, with no timeout and no log entry.
- Preset generations are keyed on a file's mtime and size; superseded generations are never reclaimed because the roster holds no join count.
- Live patch reload watches files on disk; `dsh plugin` shells out to pnpm in a profile directory.
- Skills, instructions, and presets are all discovered by scanning directories with Chokidar.

**Principles that transfer to an evictable Durable Object with a Sprite workspace:**

- Stable Plugin identity over immutable, append-only Versions, with `current`/`target` pointers, so rollback is running the current pointer and repair is appending a corrected Version (finding 2).
- Validate the model-authored surface at the **registration boundary in the host realm** — schema normalization, teaching errors, rebuilt host-owned values — rather than when a later request assembles a prompt (finding 6b).
- Never leave a half-started Version mounted: dispose before rethrowing, and report unresolved dependencies as a named pending state (finding 6c).
- Report post-settle failures the run receipt could not carry, through a steering channel plus an inspectable diagnostic (finding 6d).
- Retract by disposing one effect scope, because every registration was an effect (finding 14).
- Refuse a broken composition **up front** so nothing ever starts half-composed; audit the mounted result before anything joins it; keep a continuous invariant for what a one-shot audit misses (finding 10).
- On a rejected edit, leave the last good runtime serving (finding 11).
- Surfaces that own in-flight work must not live-recompose (finding 11); for FrockBot, no Contribution swap mid-Turn.
- Generation semantics: a running Session keeps the generation it started on; a new generation is for the next Session. This is the right answer for a DO too, and it is cheaper than migration.
- Inspect-before-you-write, served from a generated, freshness-gated catalog intersected with the live runtime (finding 3).
- Model-visible ⟺ logged, with the assembled tool schemas inside the durable request header, so a Bot-authored tool's exact model-facing surface is reconstructable (finding 8).

## Recommended FrockBot shape

1. **Two tiers, named separately.** A **Draft Package** is Bot-authored, durable in DO storage, and mounted only into the authoring Bot; a **Published Package** is promoted into the account's Package catalog and mountable by other Bots. DeepSeek has only the first tier and explicitly no promote path; FrockBot needs the second, so design the promotion command now rather than retrofitting it.
2. **Identity.** `Package { id: opaque, botId | accountId, label, versions: Version[] }` with `currentVersionId` and `targetVersionId` in DO storage. A Version is immutable and carries its source, declared Contributions, declared capability requests, the authoring Turn id, and a content digest. Never overwrite; append and update the pointer.
3. **Durable-first define.** `define` transactionally appends the Version and a `package/version-defined` event before acknowledging, validating only shape and syntax. Mounting is a separate command with its own event.
4. **Capability grants, not ambient authority.** A Version declares the Contributions and capabilities it needs. Mounting requires a durable, authenticated `package/grant` event naming the principal, the capability set, and an expiry. The runtime hands the Version a capability-scoped handle, never the Bot's own service context. This is the deliberate divergence from DeepSeek, where the authority-bearing half is ungated.
5. **Mount is idempotent and re-derived on wake.** On DO wake, replay the durable pointers and re-mount `currentVersionId`. A mount that fails during wake must not block the Bot: record the failure, leave the Package retracted, and steer the Bot with the diagnostic — the same way DeepSeek reports a post-settle failure.
6. **One effect scope per mounted Version.** Every Contribution registers through effect-returning APIs so retract is one disposal. Assert the ordering with a runtime invariant, as DeepSeek does for the tool pipeline.
7. **Fail-closed composition.** Refuse to mount a Version whose declared Contributions do not resolve. On a failed mount, keep `currentVersionId` serving and record the target as failed, so "roll back" needs no new machinery.
8. **Full provenance.** Emit the dedicated events DeepSeek declined: `package/version-defined`, `package/granted`, `package/mounted`, `package/retracted`, `package/mount-failed`, each carrying Package id, Version id, authoring Turn, and principal. Keep the assembled tool schemas in the durable request envelope so the model-facing effect of a mount is reconstructable.
9. **No mid-Turn surface swap.** Mount and retract take effect at a Turn boundary. A Version that changes the tool set invalidates the prompt prefix from the first changed schema token, which DeepSeek documents per-package; budget for it.
10. **Ship instructions before code.** Bot-authored Skills — durable documents with synchronous catalog invalidation, name+description-only at level one — deliver most of the self-extension value at a fraction of the authority risk (finding 12).

## The pi coding agent

Primary sources only, pinned to `earendil-works/pi` commit `853a80d`. Note the repo moved: `badlogic/pi-mono` now redirects to `earendil-works/pi`, and packages are scoped `@earendil-works/pi-*`. Paths below are relative to that repo.

- **What it is.** `README.md` calls it "Pi agent harness … including our self extensible coding agent"; `packages/coding-agent/docs/index.md` describes "a minimal terminal coding harness … small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and pi packages." Packages: `coding-agent` (the `pi` CLI and all end-user docs), `agent` (runtime, transport abstraction, state), `ai` (multi-provider LLM API), `tui`, `protocol`/`client`/`server`, `session-backends/sqlite-node`, `telemetry`, `evals`.
- **Extensions.** A TypeScript module loaded via jiti with no compile step, exporting a default factory `(pi: ExtensionAPI) => void | Promise<void>`. **There is no manifest — the file is the unit.** Discovery: `~/.pi/agent/extensions/*.ts` and `*/index.ts` (global), `.pi/extensions/*.ts` and `*/index.ts` (project-local, **only after the project is trusted**), plus `settings.json` `extensions` / `packages: ["npm:…","git:…"]`, plus `pi -e ./file.ts`. The API is `pi.on(event, handler)`, `pi.registerTool()`, `pi.registerCommand()`, `pi.registerShortcut()`, `pi.registerFlag()`, `pi.registerProvider()`, `pi.setActiveTools()`, `pi.appendEntry()`, `pi.sendUserMessage()`, `pi.getAllTools()`; tool params use typebox. A `tool_call` handler can return `{block: true, reason}`.
- **Hot reload, and self-modification.** `docs/extensions.md` line 1 is a banner: "pi can create extensions. Ask it to build one for your use case." The same banner heads `skills.md`, `prompt-templates.md`, `themes.md`, and `tui.md`. Reload is real and does not require a restart: `/reload` reloads "keybindings, extensions, skills, prompts, themes, and context files", `ctx.reload()` runs the same flow, and `pi.registerTool()` called after startup refreshes tools immediately — "callable by the LLM without `/reload`". The loop is closed by a shipped example, `packages/coding-agent/examples/extensions/reload-runtime.ts`, which registers an **LLM-callable `reload_runtime` tool** that queues `/reload-runtime` as a follow-up user message, because tools receive an `ExtensionContext` that lacks `ctx.reload()`. So: the agent writes a `.ts` file with its own write tool, calls `reload_runtime`, and the extension is live and durable on disk. There is also "Dynamic Tool Loading" — register many, keep few active, and a loader tool calls `pi.setActiveTools()` mid-execution, using Anthropic `defer_loading`/`tool_reference` or OpenAI `tool_search_call` natively where available.
- **Skills, prompts, instructions.** Skills implement the Agent Skills standard: directories with `SKILL.md`, discovered under `~/.pi/agent/skills/`, `~/.agents/skills/`, and `.pi/skills/` + `.agents/skills/` in cwd and ancestors up to the repo root (trusted projects only), plus package `skills/` dirs and a `--skill <path>` flag; descriptions go in the system prompt, bodies are read on demand, and each registers a `/skill:name` command. It can point at `~/.claude/skills` or `~/.codex/skills`. Prompt templates are `*.md` under `~/.pi/agent/prompts/` or `.pi/prompts/`, filename becoming `/name`. Context files are `AGENTS.md` or `CLAUDE.md`, with `AGENTS.override.md` taking precedence in its directory.
- **Persistence.** Coding-agent sessions are JSONL files on local disk under `~/.pi/agent/sessions/`, currently version 3, structured as a **tree** of immutable entries linked by `id`/`parentId` with the active leaf as a cursor, which is what makes `/tree`, `/fork`, `/clone`, and in-place `/compact` possible. The newer `packages/agent/docs/harness.md` specifies a durable runtime with three stores (write-once entries, namespaced mutable registers, an append-only usage ledger) under atomic `commit()` transactions, named **lanes** as cursors for threads and subagents, and per-operation `op.meta`/`op.state` so a crash mid-tool resumes. That document says its own format-4 code "currently in the source tree is unfinished", so treat it as spec-ahead-of-code.
- **Sandboxing.** None built in, by explicit design: `docs/security.md` states pi runs with the launching user's full permissions and that extensions do too. The only guard is **project trust** — an input-loading gate deciding whether `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, and project `.agents/skills` load at all — stored per canonical directory in `~/.pi/agent/trust.json`, defaulting to `ask`, and never prompted in non-interactive modes. Context files load regardless. The docs argue a partial in-process sandbox would be misleading and that "real isolation needs to come from the operating system or a virtualization/container boundary"; `docs/containerization.md` offers three patterns including a Gondolin extension that routes built-in tools into a local Linux micro-VM.

**What pi adds to the FrockBot picture that DeepSeek does not:** a _durable_ agent-authored extension that survives restart, an explicit model-callable reload verb, and a trust gate that is about **which inputs load** rather than which actions are allowed. That trust-root idea — the agent may write freely into its own root, and a directory only becomes an input source after a human trusts it once — is a good fit for a FrockBot Draft/Published split. Both pi and DeepSeek converge on the same honest conclusion: in-process sandboxing of agent-authored code is theatre, and the real boundary has to come from the platform. FrockBot has that boundary available and should use it.

**Unverified:** whether pi's default system prompt encourages the model to author extensions unprompted; whether an on-disk extension change triggers any automatic watcher (the docs describe only user- or tool-triggered reload); and the parts of `packages/agent/docs/harness.md` that the document itself flags as ahead of the source.

## Sources

### Kept

- [`packages/extensions/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/README.md), [`cordis-host-runner/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/README.md), [`tool-cordis/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/tool-cordis/README.md), [`cordis-client-runner/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-client-runner/README.md), [`ui-cordis/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/ui-cordis/README.md) — the current, authoritative account of dynamic Cordis Packages.
- [`packages/extensions/cordis-host-runner/src/`](https://github.com/deepseek-ai/deepseek-harness/tree/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/cordis-host-runner/src) — `registry.ts` (identity, grants, version pointers), `sandbox.ts` (globals and traps), `guard.ts` (registration boundary), `lifecycle.ts` (fiber start and disposal), `types.ts` (local approval brand).
- [`packages/extensions/tool-cordis/src/prompt.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/extensions/tool-cordis/src/prompt.ts) and [`docs/tool-catalog.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/tool-catalog.md) — the exact model-facing prompt section and the seven generated tool schemas.
- [`docs/subsystems/extensions.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/extensions.md) — the generated `ctx.dynamicCordisRunner` and `ctx.cordisInspect` service API and `cordis/*` events.
- [`packages/preset/agent-presets/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/README.md) plus its shipped `cordis` preset composition and two skills — the durable, on-disk self-modification axis.
- [`packages/boot/app-boot/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/boot/app-boot/README.md), [`packages/bundle/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/README.md), [`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/architecture.md) — profiles, bundles, patch layers, live reload, and the "where new behavior goes" table.
- [`docs/subsystems/tools.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/tools.md) and [`docs/tool-execution-pipeline.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/tool-execution-pipeline.md) — tool definition, schema DSL, result vocabulary, and the guarded pipeline.
- [`docs/subsystems/approval.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/approval.md), [`permission-presets.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/permission-presets.md), [`sandbox.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/sandbox.md) — the layered gate/policy/enforcement split.
- [`docs/cordis-primer.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-primer.md), [`docs/cordis-api/`](https://github.com/deepseek-ai/deepseek-harness/tree/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-api), [`docs/cordis-tutorial/`](https://github.com/deepseek-ai/deepseek-harness/tree/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/cordis-tutorial), [`packages/core/scope/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/core/scope/README.md) — plugin manifest, fiber lifecycle, effects, injection, and the limits of scoping.
- [`docs/subsystems/skills.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/skills.md), [`packages/skill/skill-filesystem/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/skill/skill-filesystem/README.md), [`packages/context/agent-instructions/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/context/agent-instructions/README.md) — on-disk instruction discovery and synchronous self-observation.
- [`docs/subsystems/workspace.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/workspace.md), [`filesystem.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/filesystem.md), [`shell.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/shell.md), [`terminal.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/terminal.md) — working directory, file CAS, shell and PTY seams.
- [`docs/user/guide/mcp-memory.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/user/guide/mcp-memory.md) — the authoritative statement that no memory server ships enabled.
- [`AGENTS.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/AGENTS.md) and [`docs/subsystems/session.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/docs/subsystems/session.md) — the model-visible-⟺-logged invariant and the `request/header` reconstruction contract.
- [`earendil-works/pi`](https://github.com/earendil-works/pi) at `853a80d` — `README.md`, `packages/coding-agent/docs/{index,extensions,skills,prompt-templates,usage,security,containerization,session-format}.md`, `packages/agent/docs/harness.md`, and `packages/coding-agent/examples/extensions/reload-runtime.ts`.

### Dropped or treated as non-authoritative

- **Superseded design note, retained for rationale only:** [`.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md) describes a three-tool API (`cordis_inspect`, `cordis_mount`, `cordis_unmount`) that the current seven-tool, Plugin/Package-versioned, approval-gated implementation replaced. Its _reasoning_ — why a single mount primitive beat per-capability registration tools, why the API catalog is generated, why the sandbox is explicitly not a security boundary — is still the best statement of intent, and this brief cites it only for that. Its tool names and lifecycle details are stale.
- **Stale in-repo skill:** [`presets/cordis/skills/editing-cordis-compositions/SKILL.md`](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md) still instructs the model to use `cordis_mount` and `cordis_inspect what:"api"`, which no longer exist. Cited here for its two-plane (host composition vs agent preset) doctrine and its off-limits rules, not for its tool names. Worth noting as evidence that even a well-disciplined repo lets model-facing instructions drift from the tools they describe — a hazard FrockBot inherits the moment it ships Bot-readable Skills.
- Third-party repositories, forks, blog posts, and discussion summaries — excluded by the first-party-only requirement.
- `.zh.md` and `.i18n.yaml` translations — same content, not independent evidence.

## Gaps and residual risks

- **No promote-to-durable path exists to benchmark.** DeepSeek's dynamic Packages are in-memory by decision and its durable axis (presets) is authored by copy-then-edit, not by promoting a runtime experiment. FrockBot's Draft → Published transition has no upstream precedent; it is new design work.
- **No enforced capability model for agent-authored code exists in either repo.** DeepSeek's façade and pi's project trust both narrow _what is visible_, not _what is permitted_; both say so explicitly. Every claim in this brief about capability-scoped grants is a FrockBot recommendation, not an observation.
- **No multi-tenant or account boundary to copy.** DeepSeek scopes definitions to a Session inside one process; presets scope to a preset mount; neither models an account. Bot-to-Bot and account-to-account isolation for Published Packages is FrockBot-specific.
- **No durable audit of the approval decision.** DeepSeek's general `ctx.approval` seam logs `approval/asked`/`approval/decided`, but the dynamic-package flow deliberately does not use it, so there is no upstream example of an audited mount decision.
- **Nothing here validates DO-specific behavior.** Eviction, alarms, transactional storage, hibernation, WebSocket resumption, and Sprite lifecycle have no analogue in either repo. The generation and mount-audit semantics look transferable, but that is an architectural judgement.
- **`master` moves.** All links pin commit `0a53fb55`; the two stale-documentation items noted above may be fixed upstream at any time, and the `agents-notes` corpus in particular is design history, not current contract.
- **Part of the pi account is spec-ahead-of-code by the repo's own admission**, and is labelled as such in that section.

## Appendix: package map

251 packages under `packages/<group>/<package>` at commit `0a53fb55`. Every one has a `README.md` with a `description:` frontmatter field; roles below are compressed from those descriptions, not invented. Groups are ordered as they appear on disk. Use this to map DeepSeek packages onto FrockBot Packages — the seam-shaped groups (`fs`, `shell`, `llm`, `sandbox`, `subagent`, `web`, `skill`, `storage`) are the ones with a Definition/Provider/Consumer trio and therefore the ones that translate most directly.

### acp (1)

| Path      | npm name  | Role                                                                            |
| --------- | --------- | ------------------------------------------------------------------------------- |
| `acp/acp` | `dsh-acp` | Automation-only Agent Client Protocol server driving agents over JSON-RPC stdio |

### api (5)

| Path                       | npm name                       | Role                                                                                      |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| `api/gateway`              | `dsh-api-gateway`              | Typed Client→Host calls and streams: dispatch, validation, cancellation, reconnection     |
| `api/remotes`              | `dsh-api-remotes`              | Application Remote assembly selecting typed Host capabilities and forwarded events        |
| `api/session-controller`   | `dsh-api-session-controller`   | Session control: create, resume, prompt, follow history, project live state               |
| `api/settings-controller`  | `dsh-api-settings-controller`  | Host Remote for settings and credentials: redacted reads, writes, native document opening |
| `api/workspace-controller` | `dsh-api-workspace-controller` | Workspace control: mutate navigation, follow the complete workspace projection            |

### attachment (2)

| Path                          | npm name               | Role                                               |
| ----------------------------- | ---------------------- | -------------------------------------------------- |
| `attachment/attachment`       | `dsh-attachment`       | Durable image attachments for prompts and commands |
| `attachment/attachment-local` | `dsh-attachment-local` | Local storage for attached images below `DSH_HOME` |

### boot (2)

| Path            | npm name       | Role                                                                                      |
| --------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `boot/app-boot` | `dsh-app-boot` | Shared Loader boot for profiles: environment layers, patches, diagnostics, config preview |
| `boot/cmdline`  | `dsh-cmdline`  | App-owned command lines: each app parses its own flags, `--help`, exit behavior           |

### bundle (6)

| Path                 | npm name          | Role                                                                      |
| -------------------- | ----------------- | ------------------------------------------------------------------------- |
| `bundle/acp-app`     | `dsh-acp-app`     | Automation-only ACP stdio application profile bundle                      |
| `bundle/base`        | `dsh-base`        | Shared core: model access, tools, durable sessions, safety defaults       |
| `bundle/headless`    | `dsh-headless`    | One-shot task mode: run one task, print the final answer                  |
| `bundle/sdk-app`     | `dsh-sdk-app`     | SDK stdio application profile launching a JSON-RPC harness runtime        |
| `bundle/sdk-minimal` | `dsh-sdk-minimal` | Standalone two-tool SDK profile without the shared base bundle            |
| `bundle/web-app`     | `dsh-web-app`     | Browser GUI: interactive chat, model/settings management, session history |

### client (44)

| Path                                  | npm name                                  | Role                                                                                                     |
| ------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `client/connection`                   | `dsh-client-connection`                   | Browser↔host wire layer: Remote RPC, reconnecting event stream, `/api` bridge, trust fence               |
| `client/hmr`                          | `dsh-client-hmr`                          | Development-only hot reload swapping browser client plugins in place                                     |
| `client/locale`                       | `dsh-client-locale`                       | Web GUI localization: zh/en preference, fallback, typed namespace dictionaries                           |
| `client/modules`                      | `dsh-client-modules`                      | Client module system: host composes boot graph, browser lazily loads plugin bundles                      |
| `client/store`                        | `dsh-client-store`                        | Observable browser state stores with explicit snapshots, subscriptions, lifecycle ownership              |
| `client/ui-agent-preset`              | `dsh-client-ui-agent-preset`              | Agent-preset UI: default setting, new-session chip, header label, roster management                      |
| `client/ui-approval`                  | `dsh-client-ui-approval`                  | Browser approval UI answering Host permission requests through the scoped interaction path               |
| `client/ui-attachment`                | `dsh-client-ui-attachment`                | Attachment UI: draft rail, document drop target, history gallery, lightbox                               |
| `client/ui-brand-official`            | `dsh-client-ui-brand-official`            | Official brand occupants for the sidebar in official builds                                              |
| `client/ui-chat`                      | `dsh-client-ui-chat`                      | Chat target rendering conversation nodes, details, images, actions, scroll state                         |
| `client/ui-commands`                  | `dsh-client-ui-commands`                  | Client command API: `/` source, three dispatch kinds, per-session command directory                      |
| `client/ui-conversation`              | `dsh-client-ui-conversation`              | Target-neutral conversation assembly: event/view registries, session bindings, slots, composer takeovers |
| `client/ui-deliverables`              | `dsh-client-ui-deliverables`              | Produced-files row and clickable inline file references for finished turns                               |
| `client/ui-directory-picker-browse`   | `dsh-client-ui-directory-picker-browse`   | Miller-column in-app "Select Workspace Directory" dialog                                                 |
| `client/ui-directory-picker-native`   | `dsh-client-ui-directory-picker-native`   | Browser half driving the host OS directory chooser for workspace flows                                   |
| `client/ui-goal`                      | `dsh-client-ui-goal`                      | Composer-context strip showing the goal; edit, pause, resume, clear                                      |
| `client/ui-input-trigger`             | `dsh-client-ui-input-trigger`             | Input trigger pipeline: `/` and `@` detection, grouped candidate menu, pick routing                      |
| `client/ui-jobs`                      | `dsh-client-ui-jobs`                      | Session-header action listing the background jobs this session can see                                   |
| `client/ui-layout`                    | `dsh-client-ui-layout`                    | Three-column AppFrame shell: drag handles, panel geometry service, theme presentation                    |
| `client/ui-message-feedback`          | `dsh-client-ui-message-feedback`          | Like/dislike pair and optional note in assistant message action rows                                     |
| `client/ui-model-selection`           | `dsh-client-ui-model-selection`           | `/model` popup and composer model seat over the per-session directory                                    |
| `client/ui-permission-presets`        | `dsh-client-ui-permission-presets`        | General-settings default row and `/permission` picker for the current session                            |
| `client/ui-plan`                      | `dsh-client-ui-plan`                      | Composer chip showing plan mode is on, and turning it off                                                |
| `client/ui-primitives`                | `dsh-client-ui-primitives`                | Shared React atoms: controls, icons, markdown/math, terminal/read/diff/search/web cards                  |
| `client/ui-reference`                 | `dsh-client-ui-reference`                 | `@file` and `@session` composer reference source: candidates, ordering, atomic inline references         |
| `client/ui-renderer`                  | `dsh-client-ui-renderer`                  | Browser UI renderer: React slot bindings, `ctx.uiRenderer`, assembled application root                   |
| `client/ui-schedule`                  | `dsh-client-ui-schedule`                  | Read-only Web catalog of active Schedule reminders                                                       |
| `client/ui-session`                   | `dsh-client-ui-session`                   | React and Slot adapters for session lists, interaction state, per-session context                        |
| `client/ui-settings`                  | `dsh-client-ui-settings`                  | Settings domain base: namespace scope service, schema service, settings slot contract                    |
| `client/ui-settings-general`          | `dsh-client-ui-settings-general`          | Settings shell, General section, trigger chrome, durable product-onboarding ledger                       |
| `client/ui-settings-models`           | `dsh-client-ui-settings-models`           | Models settings: provider rows, API-key management, model lists, first-run dialogs                       |
| `client/ui-settings-plugin-inventory` | `dsh-client-ui-settings-plugin-inventory` | Read-only scope-grouped plugin inventory tab with search                                                 |
| `client/ui-settings-plugins`          | `dsh-client-ui-settings-plugins`          | Plugins settings section: feature tabs, host-plane plugin cards, extension point                         |
| `client/ui-sidebar`                   | `dsh-client-ui-sidebar`                   | Sidebar shell: brand row, New Session, collapse, region seat, Settings seat                              |
| `client/ui-skill`                     | `dsh-client-ui-skill`                     | Web skill references: `/`-triggered skill source and the skill call card                                 |
| `client/ui-slots`                     | `dsh-client-ui-slots`                     | Slot registry core: SlotMap merging, register API, props types, renderer install                         |
| `client/ui-subagent`                  | `dsh-client-ui-subagent`                  | Subagent conversation catalog, continuation routing UI, `@` reference source                             |
| `client/ui-theme`                     | `dsh-client-ui-theme`                     | Theme and font-size settings: `--dsw-*` tokens, ThemeRuntime, pre-plugin bootstrap                       |
| `client/ui-tool`                      | `dsh-client-ui-tool`                      | Tool presentation: whole-call tree, keyed per-tool view slot, built-in cards                             |
| `client/ui-trajectory`                | `dsh-client-ui-trajectory`                | Turn-aware event ledger view with an interactive timing overview                                         |
| `client/ui-user-questions`            | `dsh-client-ui-user-questions`            | Composer-takeover `ask_user_question` UI and the plan-review approval card                               |
| `client/ui-workflow-run`              | `dsh-client-ui-workflow-run`              | Durable workflow-run conversation node with nested member disclosure                                     |
| `client/ui-workspace`                 | `dsh-client-ui-workspace`                 | Workspace browser/picker: grouped rows, add/rename/reorder, search, fork, archive                        |
| `client/web`                          | `dsh-client-web`                          | Web boot kernel: two-stage client plugin boot, framework-free boot page, module table                    |

### code-runtime (3)

| Path                                      | npm name                         | Role                                                                                    |
| ----------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `code-runtime/code-runtime`               | `dsh-code-runtime`               | Abstract `ctx.codeRuntime` seam running one model-written program against host bindings |
| `code-runtime/code-runtime-python`        | `dsh-code-runtime-python`        | fd-3 wire protocol between a Node host and a CPython subprocess                         |
| `code-runtime/code-runtime-worker-thread` | `dsh-code-runtime-worker-thread` | Worker-thread backend running each program in a fresh Node worker                       |

### compaction (4)

| Path                                       | npm name                            | Role                                                                       |
| ------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------- |
| `compaction/compaction`                    | `dsh-compaction`                    | Shared compaction contract: what condensation does and how to implement it |
| `compaction/compaction-basic`              | `dsh-compaction-basic`              | Automatic condensation summarizing older history as token pressure builds  |
| `compaction/compaction-tool-result-pruner` | `dsh-compaction-tool-result-pruner` | Tool-output trimming with configurable size limits                         |
| `compaction/command-compact`               | `dsh-command-compact`               | The on-demand `/compact` slash command for interactive compositions        |

### context (6)

| Path                           | npm name                   | Role                                                                         |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------- |
| `context/agent-instructions`   | `dsh-agent-instructions`   | Workspace-instruction context: `AGENTS.md` / `CLAUDE.md` loading and refresh |
| `context/file-reference`       | `dsh-file-reference`       | File-reference discovery and `@file` mention grammar for host-backed UIs     |
| `context/file-reference-local` | `dsh-file-reference-local` | Local-workspace `@file` completion provider over `ctx.fileReferences`        |
| `context/session-reference`    | `dsh-session-reference`    | Cross-session snapshot references and durable untrusted model context        |
| `context/time-context`         | `dsh-time-context`         | Opt-in per-step clock context: current time, browser zone, elapsed time      |
| `context/tmux-context`         | `dsh-tmux-context`         | Opt-in per-turn tmux session, window, and pane awareness                     |

### core (8)

| Path                           | npm name                      | Role                                                                                   |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------- |
| `core/agent`                   | `dsh-agent`                   | Agent handle, live registry, process-local initiator scope, `agent/*` event vocabulary |
| `core/agent-default-model`     | `dsh-agent-default-model`     | Deployment default model selection for freshly created agents                          |
| `core/agent-loop`              | `dsh-agent-loop`              | Default agent driver: how agents are created and how turns and steps run               |
| `core/agent-tool-presentation` | `dsh-agent-tool-presentation` | Agent-plane selector for which form of its tools a preset's models see                 |
| `core/scope`                   | `dsh-scope`                   | Scoped-registration library isolating contributions per agent or per group             |
| `core/session`                 | `dsh-session`                 | Event-sourced session log and in-memory store behind every agent interaction           |
| `core/system-prompt`           | `dsh-system-prompt`           | System-prompt assembly: sections, variables, tool-schema sources, configuration        |
| `core/tools`                   | `dsh-tools`                   | Tool registry and execution pipeline: register, restrict, present, debug tools         |

### credentials (3)

| Path                            | npm name                | Role                                                                                        |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `credentials/authorization`     | `dsh-authorization`     | Authorization flow registry for credentials needing a conversation with a human             |
| `credentials/credentials`       | `dsh-credentials`       | Credential seam resolving, describing, storing credentials without secrets in configuration |
| `credentials/credentials-local` | `dsh-credentials-local` | File-backed credentials provider with environment layering                                  |

### e2b (3)

| Path                 | npm name             | Role                                                                           |
| -------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `e2b/e2b`            | `dsh-e2b`            | One shared remote Linux sandbox: configuration, lifetime, startup and shutdown |
| `e2b/fs-e2b`         | `dsh-fs-e2b`         | File operations inside the shared remote E2B sandbox                           |
| `e2b/subprocess-e2b` | `dsh-subprocess-e2b` | Shell commands and terminals inside the shared remote E2B sandbox              |

### examples (1)

| Path                        | npm name               | Role                                                                   |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `examples/agent-spine-demo` | `dsh-agent-spine-demo` | Default executor-less, UI-less agent spine as one Cordis bundle plugin |

### experimental (8)

| Path                                  | npm name                                  | Role                                                                            |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `experimental/agent-team`             | `dsh-experimental-agent-team`             | Run a team of named agents: durable member messages and shared task board       |
| `experimental/agent-team-profile`     | `dsh-experimental-agent-team-profile`     | Private Agent Teams profile layer over `dsh-base` for source checkouts          |
| `experimental/agent-team-web-profile` | `dsh-experimental-agent-team-web-profile` | Adds the experimental Agent Teams panel to a source-checkout Web profile        |
| `experimental/client-ui-agent-team`   | `dsh-experimental-client-ui-agent-team`   | Web Agent Teams roster, shared task board, teammate navigation panel            |
| `experimental/inspector`              | `dsh-experimental-inspector`              | Chrome DevTools inspection for Host and browser Cordis runtimes, plus query API |
| `experimental/tool-agent-team`        | `dsh-experimental-tool-agent-team`        | Ten tools letting the model create, message, and coordinate teammates           |
| `experimental/webworker-packer`       | `dsh-experimental-webworker-packer`       | Browser-worker VFS image packaging for the experimental preview deployment      |
| `experimental/webworker-runtime`      | `dsh-experimental-webworker-runtime`      | Browser-worker harness hosting for the experimental Web preview runtime         |

### extensions (4) — the self-modification family

| Path                              | npm name                   | Role                                                                            |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `extensions/cordis-client-runner` | `dsh-cordis-client-runner` | Browser half of dynamic Packages: answers run requests, loads browser-half code |
| `extensions/cordis-host-runner`   | `dsh-cordis-host-runner`   | Host half: definition registry, vm sandbox, run round trip, inspect registry    |
| `extensions/tool-cordis`          | `dsh-tool-cordis`          | The seven model-facing tools for dynamic-package workflows                      |
| `extensions/ui-cordis`            | `dsh-client-ui-cordis`     | Browser surfaces: frame-wide panel, tool cards, `@pluginId` input source        |

### feedback (2)

| Path                        | npm name               | Role                                                           |
| --------------------------- | ---------------------- | -------------------------------------------------------------- |
| `feedback/command-feedback` | `dsh-command-feedback` | Free-text session feedback through a `/feedback` command       |
| `feedback/message-feedback` | `dsh-message-feedback` | Per-message ratings and notes for finalized assistant messages |

### fs (7)

| Path                         | npm name                      | Role                                                                               |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `fs/fs`                      | `dsh-fs`                      | The `ctx.fs` filesystem service contract for mounting or implementing backends     |
| `fs/fs-local`                | `dsh-fs-local`                | Host-filesystem backend for `ctx.fs` providing local file access                   |
| `fs/fs-observation-policy`   | `dsh-fs-observation-policy`   | Read-before-edit policy guarding write and edit behavior                           |
| `fs/fs-sandbox`              | `dsh-fs-sandbox`              | Sandbox-enforcing `ctx.fs` backend confining model file mutations to the workspace |
| `fs/tool-fs`                 | `dsh-tool-fs`                 | Model-facing `read`, `read_image`, `write`, and `edit` tools                       |
| `fs/tool-fs-search`          | `dsh-tool-fs-search`          | Model-facing `glob` and `grep` workspace discovery tools                           |
| `fs/tool-str-replace-editor` | `dsh-tool-str-replace-editor` | Standalone Claude-Code-style `str_replace_editor` tool over `ctx.fs`               |

### goal (4)

| Path                     | npm name                | Role                                                                              |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------- |
| `goal/goal`              | `dsh-goal`              | Persisted same-session goal service: one durable completion objective per session |
| `goal/goal-round-driver` | `dsh-goal-round-driver` | Same-session continuation driver running automatic goal rounds                    |
| `goal/command-goal`      | `dsh-command-goal`      | Human-facing `/goal` slash command for UI command planes                          |
| `goal/tool-goal`         | `dsh-tool-goal`         | Model-facing `get_goal`, `create_goal`, and `update_goal` tools                   |

### guard (2)

| Path                         | npm name                       | Role                                                                    |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `guard/repeat-tool-reminder` | `dsh-repeat-tool-reminder`     | Advisory guard nudging the model out of identical tool-call loops       |
| `guard/timeout-policy`       | `dsh-tool-call-timeout-policy` | Cooperative time limit mapping a settled timeout to a clear model error |

### hooks (3)

| Path                      | npm name                | Role                                                                              |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `hooks/hook-protocol`     | `dsh-hook-protocol`     | Shared hook rules behind the Claude Code and Codex bridges                        |
| `hooks/hooks-claude-code` | `dsh-hooks-claude-code` | Run existing Claude Code hooks during agent runs: block, attach context, continue |
| `hooks/hooks-codex`       | `dsh-hooks-codex`       | Run existing Codex hooks during agent runs: block, attach context, continue       |

### host (7)

| Path                           | npm name                           | Role                                                                                     |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `host/directory-picker`        | `dsh-host-directory-picker`        | Workspace-directory picking seam: service contract, capability vocabulary, error codes   |
| `host/directory-picker-auto`   | `dsh-host-directory-picker-auto`   | Resolves the host situation at boot and mounts native or browse backend                  |
| `host/directory-picker-browse` | `dsh-host-directory-picker-browse` | In-app browsing backend: one-level listing and child-directory creation                  |
| `host/directory-picker-native` | `dsh-host-directory-picker-native` | Native-OS chooser backend for operators at the host's display                            |
| `host/frontend-static`         | `dsh-host-frontend-static`         | SPA dist server: webserver fallback seat, traversal rejection, index fallback            |
| `host/plugin-inventory`        | `dsh-host-plugin-inventory`        | Read-only Loader plugin-state projection with each agent preset's composition            |
| `host/webserver`               | `dsh-host-webserver`               | The web GUI HTTP server: route and upgrade registration, index transforms, fallback seat |

### identity (1)

| Path                         | npm name                | Role                                                                              |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `identity/anonymous-user-id` | `dsh-anonymous-user-id` | Anonymous per-home identity correlating telemetry, feedback, and provider records |

### interaction (5)

| Path                             | npm name                 | Role                                                                               |
| -------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `interaction/commands`           | `dsh-commands`           | Human slash-command registry running commands without creating a model message     |
| `interaction/permission-presets` | `dsh-permission-presets` | User-facing presets bundling sandbox mode with an approval policy                  |
| `interaction/tool-ask-user`      | `dsh-tool-ask-user`      | Model-facing `ask_user_question` tool over the user-questions seam                 |
| `interaction/user-approval`      | `dsh-user-approval`      | Channel-neutral one-shot fail-closed approval seam                                 |
| `interaction/user-questions`     | `dsh-user-questions`     | Waterfall question-and-answer service for tools, permissions, and Web interactions |

### jobs (3)

| Path              | npm name         | Role                                                                              |
| ----------------- | ---------------- | --------------------------------------------------------------------------------- |
| `jobs/jobs`       | `dsh-jobs`       | Background-job registry contract: ids, ownership, lifecycle, completion listeners |
| `jobs/jobs-local` | `dsh-jobs-local` | Process-local job registry: per-owner admission, lifecycle, teardown              |
| `jobs/tool-jobs`  | `dsh-tool-jobs`  | Model-facing `job_output`, `job_list`, `job_kill` controls and completion notices |

### llm (7)

| Path                                    | npm name                                | Role                                                                                 |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `llm/llm`                               | `dsh-llm`                               | Provider-neutral model-call service: streaming, adapter registration, model metadata |
| `llm/llm-deepseek`                      | `dsh-llm-deepseek`                      | DeepSeek chat-completions adapter: `deepseek-official` route, thinking, image input  |
| `llm/llm-pi-ai`                         | `dsh-llm-pi-ai`                         | pi-ai multi-provider adapter routing through catalogs and hand-declared gateways     |
| `llm/llm-retry`                         | `dsh-llm-retry`                         | Retry executor recovering model requests at durable agent-step boundaries            |
| `llm/deepseek-llm-api-extensions`       | `dsh-deepseek-llm-api-extensions`       | DeepSeek request-extension registry for lifecycle-owned top-level API fields         |
| `llm/plugin-package-inventory-deepseek` | `dsh-plugin-package-inventory-deepseek` | Active Loader package inventory metadata sent with official DeepSeek requests        |
| `llm/token-meter`                       | `dsh-token-meter`                       | Replay-aware token and context-pressure measurement for prompts and compaction       |

### lsp (3)

| Path            | npm name        | Role                                                                                        |
| --------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `lsp/lsp`       | `dsh-lsp`       | LSP capability seam: provider selection by extension, four normalized operations            |
| `lsp/lsp-stdio` | `dsh-lsp-stdio` | Stdio language-server provider: server commands, extension mappings, transient-open queries |
| `lsp/tool-lsp`  | `dsh-tool-lsp`  | Model-facing `lsp` tool: four read-only navigation operations with bounded results          |

### mcp (1)

| Path             | npm name         | Role                                                                   |
| ---------------- | ---------------- | ---------------------------------------------------------------------- |
| `mcp/mcp-client` | `dsh-mcp-client` | MCP client bridge registering external MCP server tools on `ctx.tools` |

### plan (1)

| Path             | npm name        | Role                                                                   |
| ---------------- | --------------- | ---------------------------------------------------------------------- |
| `plan/plan-mode` | `dsh-plan-mode` | Per-agent planning feature with `/plan` command and user-reviewed exit |

### preset (2)

| Path                   | npm name            | Role                                                                  |
| ---------------------- | ------------------- | --------------------------------------------------------------------- |
| `preset/agent-presets` | `dsh-agent-presets` | Per-session agent composition from preset `cordis.yml` files          |
| `preset/persona`       | `dsh-persona`       | Composable persona row giving one agent its own system-prompt persona |

### runtime-diagnostics (1)

| Path                             | npm name         | Role                                                                                 |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| `runtime-diagnostics/invariants` | `dsh-invariants` | Registry service running package-owned runtime invariant checks on live compositions |

### sandbox (4)

| Path                          | npm name                  | Role                                                                   |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `sandbox/sandbox`             | `dsh-sandbox`             | Process-sandbox service contract for same-world subprocess confinement |
| `sandbox/sandbox-local`       | `dsh-sandbox-local`       | Per-platform local sandbox backends for Linux, macOS, and Windows      |
| `sandbox/sandbox-policy`      | `dsh-sandbox-policy`      | Shared per-call sandbox policy resolver and current model context      |
| `sandbox/sandbox-windows-acl` | `dsh-sandbox-windows-acl` | Windows restricted-token write-restriction sandbox backend             |

### schedule (1)

| Path                | npm name       | Role                                                                                   |
| ------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `schedule/schedule` | `dsh-schedule` | Session-local durable reminders: `schedule_create/list/delete` tools and live delivery |

### sdk (3)

| Path           | npm name                 | Role                                                                             |
| -------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `sdk/client`   | `dsh-sdk-client`         | TypeScript SDK client spawning a runtime subprocess and driving turns over stdio |
| `sdk/protocol` | `dsh-sdk-protocol`       | SDK wire protocol: newline-delimited JSON-RPC transport plus named message types |
| `sdk/server`   | `dsh-sdk-jsonrpc-server` | Stdio JSON-RPC serving plugin letting out-of-process SDK clients drive agents    |

### session (14)

| Path                                     | npm name                             | Role                                                                                    |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `session/session-checkpoint-policy`      | `dsh-session-checkpoint-policy`      | Semantic durability checkpoints so crashes lose no model request or side effect         |
| `session/session-log-deepseek`           | `dsh-session-log-deepseek`           | Incremental canonical session-log upload for official DeepSeek request metadata         |
| `session/session-persistence`            | `dsh-session-persistence`            | Durable session-storage seam for choosing, resuming, or building a backend              |
| `session/session-persistence-jsonl`      | `dsh-session-persistence-jsonl`      | Shipped JSONL persistence backend with optional Zstandard compression                   |
| `session/session-persistence-sqlite`     | `dsh-session-persistence-sqlite`     | Opt-in SQLite packed-row session persistence backend                                    |
| `session/session-projection`             | `dsh-session-projection`             | Projection registry serving whole current values of log-derived per-session state       |
| `session/session-projection-cache`       | `dsh-session-projection-cache`       | Persisted projection cache: durable checkpoints, zero-I/O list reads, faster cold folds |
| `session/session-stats`                  | `dsh-session-stats`                  | Whole-log conversation counts and wall times as a `sessionStats` projection             |
| `session/session-telemetry`              | `dsh-session-telemetry`              | Session-telemetry capture seam with redaction rules and a backend contract              |
| `session/session-telemetry-otel`         | `dsh-session-telemetry-otel`         | OpenTelemetry backend: modes, exporter configuration, what leaves the machine           |
| `session/session-title`                  | `dsh-session-title`                  | Log-backed session titles: source selection, service configuration, title state         |
| `session/session-title-llm`              | `dsh-session-title-llm`              | Shared model-backed title generation policy for auxiliary LLM requests                  |
| `session/session-title-all-prompts-llm`  | `dsh-session-title-all-prompts-llm`  | All-messages LLM session-title provider                                                 |
| `session/session-title-first-prompt-llm` | `dsh-session-title-first-prompt-llm` | First-message LLM session-title provider                                                |

### session-query (4)

| Path                                 | npm name                   | Role                                                                                          |
| ------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| `session-query/session-query`        | `dsh-session-query`        | Unified history query service: exact reads, relationship traces, provider-independent filters |
| `session-query/session-query-sqlite` | `dsh-session-query-sqlite` | SQLite FTS5 full-text search backend over session history                                     |
| `session-query/session-log-export`   | `dsh-session-log-export`   | Session-log ZIP export: streaming, authenticated download route, header action, `/export`     |
| `session-query/tool-session-query`   | `dsh-tool-session-query`   | Workspace-authorized model tools for prior-session search, tracing, event reads               |

### settings (2)

| Path                     | npm name            | Role                                                                                          |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| `settings/settings`      | `dsh-settings`      | User-settings service: register namespaces, read resolved values, wire configuration surfaces |
| `settings/settings-file` | `dsh-settings-file` | File-backed settings provider over a YAML/JSON document with hot reload                       |

### shell (10)

| Path                         | npm name                   | Role                                                                                 |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `shell/shell`                | `dsh-shell`                | The bash executor seam (`ctx.shell`) for composing or implementing command execution |
| `shell/shell-env`            | `dsh-shell-env`            | Managed `DSH_*` environment every model shell call runs with                         |
| `shell/bash-local`           | `dsh-bash-local`           | Default POSIX Bash executor for unconfined command execution                         |
| `shell/bash-sandbox`         | `dsh-bash-sandbox`         | Sandbox-consuming Bash executor with denial and escalation facts                     |
| `shell/pwsh-local`           | `dsh-pwsh-local`           | Local PowerShell executor for unconfined command execution                           |
| `shell/pwsh-sandbox`         | `dsh-pwsh-sandbox`         | Sandbox-consuming PowerShell executor with denial facts                              |
| `shell/tool-bash`            | `dsh-tool-bash`            | Model-facing `bash` tool: one-shot execution, background jobs, sandbox escalation    |
| `shell/tool-bash-persistent` | `dsh-tool-bash-persistent` | Model-facing persistent bash tool with owner-scoped state across calls               |
| `shell/tool-pwsh`            | `dsh-tool-pwsh`            | Model-facing `pwsh` tool: one-shot execution, background jobs, sandbox escalation    |
| `shell/tool-pwsh-persistent` | `dsh-tool-pwsh-persistent` | Model-facing persistent pwsh tool with owner-scoped state across calls               |

### skill (4)

| Path                     | npm name               | Role                                                                                 |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------ |
| `skill/skill`            | `dsh-skill`            | Skill provider registry merging, resolving, and loading skills from any source       |
| `skill/skill-badge`      | `dsh-skill-badge`      | Bundled optional "powered by dsh" badge skill provider                               |
| `skill/skill-filesystem` | `dsh-skill-filesystem` | Local filesystem skill provider discovering and watching project, custom, user roots |
| `skill/tool-skill`       | `dsh-tool-skill`       | Model-facing skill catalog and loader tool for the session skill catalog             |

### spill (3)

| Path                 | npm name           | Role                                                                                 |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `spill/spill`        | `dsh-spill`        | Spill storage service saving oversized tool text and returning a retrievable locator |
| `spill/spill-local`  | `dsh-spill-local`  | Local filesystem spill backend: session-scoped private files, read or grep retrieval |
| `spill/spill-policy` | `dsh-spill-policy` | Tool-result spill policy keeping oversized text out of context with previews         |

### storage (4)

| Path                     | npm name             | Role                                                                                 |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `storage/storage`        | `dsh-storage`        | Storage hub (`ctx.storage`) mounting named backends and data-form facilities         |
| `storage/storage-domain` | `dsh-storage-domain` | Domain data form: schema-validated, change-emitting KV domains over storage backends |
| `storage/storage-json`   | `dsh-storage-json`   | JSON storage backend with whole-unit and per-record files under a root               |
| `storage/storage-sqlite` | `dsh-storage-sqlite` | SQLite storage backend: document-per-row KV storage in one database file             |

### subagent (11)

| Path                                  | npm name                         | Role                                                                            |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `subagent/subagent`                   | `dsh-subagent`                   | Subagent delegation seam: provider backends, delegation tools, child-agent runs |
| `subagent/subagent-acp`               | `dsh-subagent-acp`               | Out-of-process ACP subagent backend driving a child ACP agent command           |
| `subagent/subagent-claude-code`       | `dsh-subagent-claude-code`       | One-shot Claude Code subagent provider for unattended delegation                |
| `subagent/subagent-codex`             | `dsh-subagent-codex`             | One-shot Codex subagent provider for unattended delegation                      |
| `subagent/subagent-dsh-sdk`           | `dsh-subagent-dsh-sdk`           | Out-of-process SDK subagent backend driving a child Harness runtime             |
| `subagent/subagent-fork-in-process`   | `dsh-subagent-fork-in-process`   | In-process fork backend seeding children with the parent's completed turns      |
| `subagent/subagent-in-process-driver` | `dsh-subagent-in-process-driver` | Shared in-process run driver for the spawn and fork lifecycles                  |
| `subagent/subagent-spawn-in-process`  | `dsh-subagent-spawn-in-process`  | In-process spawn backend for fresh-child delegation                             |
| `subagent/tool-subagent`              | `dsh-tool-subagent`              | Model-facing delegation tool over a subagent provider                           |
| `subagent/tool-subagent-control`      | `dsh-tool-subagent-control`      | Global `send_message`, `interrupt_agent`, and `list_agents` tools               |
| `subagent/tool-subagent-report`       | `dsh-tool-subagent-report`       | Child-scoped `report` tool: the child-to-parent return channel                  |

### subprocess (3)

| Path                          | npm name               | Role                                                                                     |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `subprocess/subprocess`       | `dsh-subprocess`       | `ctx.subprocess` service starting, observing, terminating managed children and terminals |
| `subprocess/subprocess-local` | `dsh-subprocess-local` | Local host provider running managed process trees and real terminal sessions             |
| `subprocess/win32-process`    | `dsh-win32-process`    | Low-level Win32 process primitives behind the Windows ACL sandbox                        |

### terminal (3)

| Path                     | npm name            | Role                                                                                  |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------- |
| `terminal/terminal`      | `dsh-terminal`      | Owner-scoped `ctx.terminals` service for persistent terminal sessions                 |
| `terminal/terminal-bash` | `dsh-terminal-bash` | Shipped interactive bash/pwsh backend with readiness detection and bounded output     |
| `terminal/tool-terminal` | `dsh-tool-terminal` | Six persistent terminal tools with owner isolation, bounded results, background sends |

### test-support (6)

| Path                              | npm name                  | Role                                                                                 |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `test-support/agent-loop-testkit` | `dsh-agent-loop-testkit`  | Shared service mounting for tests exercising the concrete AgentLoop                  |
| `test-support/client-runtime`     | `dsh-client-test-runtime` | jsdom slot test runtime for browser feature specs                                    |
| `test-support/llm-mock-server`    | `dsh-llm-mock-server`     | Scriptable OpenAI-compatible fault server for testing adapters without a key         |
| `test-support/llm-replay`         | `dsh-llm-replay`          | Keyless LLM replay plugin booting the real agent against recorded transcripts        |
| `test-support/loader-smoke`       | `dsh-loader-smoke`        | Subprocess and direct-agent harness for keyless example smoke tests                  |
| `test-support/session-snapshot`   | `dsh-session-snapshot`    | Session-log snapshot support: manifests, redaction, normalization, protocol adapters |

### todo (1)

| Path             | npm name        | Role                                                                                              |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `todo/tool-todo` | `dsh-tool-todo` | Model-facing `todo_write` tool: whole-list replacement, per-session ownership, `todos` projection |

### typert (4)

| Path               | npm name               | Role                                                                                    |
| ------------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| `typert/generator` | `dsh-typert-generator` | Build-time Typert generator: type analysis, models, artifact emission                   |
| `typert/loader`    | `dsh-typert-loader`    | Loader integration contributing mounted packages' reflection and schemas at runtime     |
| `typert/protocol`  | `dsh-typert-protocol`  | Shared Typert Remote protocol: decorators, wire descriptors, codecs, provider contracts |
| `typert/registry`  | `dsh-typert-registry`  | Runtime registry storing package reflection, Zod schemas, Remote invocation descriptors |

### util (12)

| Path                      | npm name                  | Role                                                                                   |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| `util/atomic-write`       | `dsh-atomic-write`        | Atomic file replacement and cross-process writer locking                               |
| `util/brand`              | `dsh-brand`               | Nominal string types and stateless constructors for cross-package identifiers          |
| `util/crypto`             | `dsh-util-crypto`         | Cross-runtime UUID generation replacing secure-context-only `crypto.randomUUID`        |
| `util/deque`              | `dsh-deque`               | Circular deque with amortized constant-time operations and bounded vacant storage      |
| `util/home-paths`         | `dsh-home-paths`          | Shared Harness home and user-data path resolution with tilde expansion                 |
| `util/launch-environment` | `dsh-launch-environment`  | Immutable environment snapshot remembering which layer supplied each value             |
| `util/native-command`     | `dsh-native-command`      | Host-native command and path-opening utilities with cancellation and WSL handoff       |
| `util/output-retention`   | `dsh-output-retention`    | Bounded model-facing output: item and text retainers plus omission footer              |
| `util/time`               | `dsh-util-time`           | IANA time-zone validation and canonicalization at wire boundaries                      |
| `util/timeout`            | `dsh-timeout`             | Timeout arithmetic, deadline fusion, and timeout-versus-cancel classification          |
| `util/values`             | `dsh-util-values`         | JSON validation, detached snapshots, deep freezing, structural equality, union helpers |
| `util/workspace-path`     | `dsh-util-workspace-path` | Browser-safe workspace path joining, home abbreviation, display titles                 |

### web (6)

| Path                        | npm name                    | Role                                                                                |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `web/web`                   | `dsh-web`                   | Web access service (`ctx.web`): search and fetch through interchangeable providers  |
| `web/web-fetch-http`        | `dsh-web-fetch-http`        | Anonymous public HTTP(S) fetch backend with same-origin redirects and text decoding |
| `web/web-search-deepseek`   | `dsh-web-search-deepseek`   | DeepSeek-backed search provider over the Anthropic-compatible Messages API          |
| `web/web-search-exa`        | `dsh-web-search-exa`        | Exa-backed search provider with portable snippets and publication dates             |
| `web/web-search-perplexity` | `dsh-web-search-perplexity` | Perplexity-backed search provider with generated answers and citations              |
| `web/tool-web`              | `dsh-tool-web`              | Model-facing `web_search` and `web_fetch` tools over `ctx.web`                      |

### webhook (2)

| Path                     | npm name             | Role                                                                               |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `webhook/webhook`        | `dsh-webhook`        | Webhook rule runtime registering trusted external-event policies creating Sessions |
| `webhook/webhook-github` | `dsh-webhook-github` | Signed GitHub webhook adapter routing authenticated JSON events into the runtime   |

### workflow (4)

| Path                              | npm name                     | Role                                                                                            |
| --------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `workflow/workflow`               | `dsh-workflow`               | Workflow orchestration capability (`ctx.workflowEngine`) running scripts that fan out subagents |
| `workflow/workflow-worker-thread` | `dsh-workflow-worker-thread` | Worker-thread workflow engine executing orchestration scripts off the host event loop           |
| `workflow/tool-workflow`          | `dsh-tool-workflow`          | Model-facing `workflow` tool running a JavaScript orchestration script                          |
| `workflow/tool-ralph`             | `dsh-tool-ralph`             | Model-facing `ralph` tool: fixed foreground fresh-agent loop toward one objective               |

### workspace (1)

| Path                  | npm name        | Role                                                                               |
| --------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `workspace/workspace` | `dsh-workspace` | Workspace entity registry: durable records and header-validated session membership |

> All npm names are prefixed `@deepseek-ai/`, elided above for width. Every package additionally publishes a mandatory `./invariant` companion (finding 10's continuous-check contract) — 251 of them, verified mechanically by `pnpm run verify-package-invariants`.
