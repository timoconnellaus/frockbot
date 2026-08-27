# Research: Cordis as the foundation for a Pi-backed extensible Grokbot desktop clone

## Summary

**Recommendation: do not make Cordis the primary foundation for the first desktop release.** Use Pi directly as the agent backend—preferably in a separate process through its documented JSONL RPC mode, or through `AgentSession` when same-process embedding is acceptable—and build a narrow desktop host/API around it. Cordis is a strong composition and lifecycle system, and DeepSeek Harness (DSH) demonstrates that it can support a thoroughly modular agent product, but adopting it beside Pi creates two overlapping plugin/lifecycle/package systems while providing **no security boundary** for chat-generated code.

Cordis becomes attractive only if the product intends to replace or substantially wrap Pi’s own agent loop, session, tool, policy, and extension surfaces with a DSH-like service graph. In that case, first validate it behind a small proof of concept and pin or vendor it: upstream explicitly labels the API unstable, the core and loader are release candidates, and DSH itself vendors and materially patches Cordis rather than consuming stock packages.

> **Scope note.** This report uses primary sources only. No official original Grok Bot source repository was identifiable. The official xAI product announcement verifies the target experience—persistent conversational bots, their own computers, approvals, multiple bots, and learned routines—but not its implementation. [xAI: Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)

## What Cordis actually is

### Verified facts

1. **A context is a scoped service repository, not a general application container.** `Context` is proxied through `ReflectService`; it owns built-in registry, event, reflection, and logger services. `extend()` creates a prototypically derived context, while `isolate(name)` assigns a new symbol for one service name in that derived context. [`packages/core/src/context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)

2. **Services are resolved by stable context keys and declared injection.** DSH’s official Cordis primer describes plugins as functions/objects or `Service` subclasses, contexts as repositories of `ctx.<key>` services, and `inject` as the mechanism that keeps a plugin pending until required services exist. [DSH Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)

3. **Plugin lifecycle is represented by fibers.** A mounted plugin gets a child context and `Fiber`; its configuration is schema-validated, dependency implementations are tracked, and the fiber transitions through pending, loading, active, failed, unloading, and disposed states. When a dependency disappears or changes, Cordis unloads/reloads the affected fiber. [`packages/core/src/fiber.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts)

4. **Effects are ownership and cleanup, not OS effects.** `ctx.effect(setup)` collects one or more disposers and unwinds them in reverse order. Plugin teardown clears owned effects; event registrations made through `ctx.on()` are likewise intended to be reversible. Async setup and cleanup are supported. [`packages/core/src/fiber.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts); [DSH Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)

5. **Events provide four interaction styles.** The official DSH primer documents `emit` (synchronous observation), `waterfall` (synchronous around-middleware with `next()` and short-circuiting), `parallel` (awaited fan-out), and `serial` (awaited ordered handling). This is a useful policy/interception surface, but waterfall correctness depends on listeners delegating when appropriate. [DSH Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)

6. **The loader reconciles declarative plugin rows.** Loader entries import a named module, unwrap its export, create an entry context, resolve/interpolate config, and mount it through the registry. Config changes can update/restart a fiber, disabling an entry disposes it, and service requirements can hold it pending. The broader package set includes include/group/HMR support. [`packages/loader/src/config/entry.ts`](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/config/entry.ts), [`packages/loader/src/index.ts`](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/index.ts), [Cordis repository](https://github.com/cordiverse/cordis)

7. **“Isolation” is service-realm isolation only.** `Context.isolate()` changes the symbol used to resolve a named service within a derived context. Plugins still execute as ordinary JavaScript in the same process and can use Node APIs available to that process. There is no worker, VM, process, filesystem, network, or capability sandbox in the core isolation mechanism. [`packages/core/src/context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)

8. **Cordis WebUI and server are separate optional ecosystems.** The WebUI repository supplies a Vue client, UI components/registry, and plugins for loader, logger, market, notifier, and server integration; its client package still describes itself as “Koishi Console Client.” [Cordis WebUI repository](https://github.com/cordiverse/webui), [`packages/client/package.json`](https://github.com/cordiverse/webui/blob/main/packages/client/package.json). The server repository provides an HTTP/WebSocket server plus ACL, proxy, static, and echo packages. [Cordis server repository](https://github.com/cordiverse/server), [`packages/core/package.json`](https://github.com/cordiverse/server/blob/main/packages/core/package.json)

### Inference for this product

Cordis is best understood as **dynamic dependency injection plus event middleware plus deterministic teardown plus declarative reconciliation**. That is valuable for long-running hosts where capabilities appear, disappear, or are replaced. It is not an Electron framework, a renderer security model, an agent protocol, or a safe plugin executor. Its generic WebUI can contribute ideas and utilities, but a polished Grokbot clone would still need its own chat/session/computer UX and desktop bridge.

## How DeepSeek Harness uses Cordis

### Verified facts

- DSH makes the Cordis tree the architecture of the whole product: model adapters, tool registry, sessions, persistence, sandbox, approval policy, settings, credentials, telemetry, agent loop, web app, and headless mode are plugins. Registrations unwind when their owner unloads. [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- Boot is layered. Profiles stack bundles, then apply profile-, home-, and CLI-level patches to an ordered entry list. `web` adds the browser app; `headless` adds a one-shot runner without a server. The live resolved tree is inspectable with `dsh --profile web --dump-config`. [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- DSH uses durable session events for facts that must survive reload, live `agent/*` events for in-flight interception, and capability events/services for replaceable providers. The session log is the source of model-visible context and preserves chunks for replay/UI fidelity. [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- DSH’s web command starts a local web server at `127.0.0.1:3080`; the UI selects a workspace and asks for approvals under the active permission policy. [DSH README](https://github.com/deepseek-ai/deepseek-harness), [Web UI guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)
- DSH **vendors** Cordis. Its manifest pins core at `4.0.0-rc.7` and records extensive local changes including lifecycle hardening, transactional loader reconciliation, HMR/config-watching fixes, lazy config resolution, and durable writes. [DSH `vendor/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)

### Inference

DSH proves the Cordis model can scale to a real agent harness, but it does **not** prove that stock Cordis is a low-risk library dependency. DSH receives maximum value because every subsystem follows the same service/event/effect model, and it pays for that consistency by owning a forked framework layer. A Pi-backed desktop that keeps Pi’s agent loop and extensions would receive less benefit while retaining much of that integration and maintenance cost.

## How Pi’s extension model differs

### Verified facts

Pi extensions are TypeScript modules whose factory receives `ExtensionAPI`. They subscribe to agent lifecycle events, register LLM-callable tools, commands, shortcuts, flags, renderers, providers, and user interactions. Auto-discovered global or project extensions can be reloaded; project-local extensions load only after project trust. [Pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

Pi packages bundle extensions, skills, prompts, and themes, are installable from npm, git, or local paths, and can be pinned. Package resources can be enabled/disabled and filtered. Pi explicitly warns that packages and extensions run with full system access and that source should be reviewed. [Pi package docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)

For host integration, Pi offers JSONL RPC over stdin/stdout and recommends `AgentSession` directly for Node/TypeScript applications. RPC streams events and includes a request/response subprotocol for extension dialogs and notifications; some terminal-specific UI methods degrade or become no-ops. [Pi RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)

### Comparison

| Dimension | Cordis | Pi |
| --- | --- | --- |
| Unit of extension | Arbitrary service/plugin in a context tree | Agent extension factory plus skills/prompts/themes |
| Primary goal | Compose an entire changing application | Extend a specific coding-agent runtime |
| Dependency model | Named injected services; pending/reactivation | API passed to factory; agent lifecycle events |
| Teardown | First-class owned reversible effects/fibers | Reload/unload through Pi’s extension loader and event registrations |
| Configuration | Declarative loader rows, includes, groups, patches, HMR | Discovery locations, settings, package manifests, CLI flags |
| Service replacement | Native context isolation/provider replacement | Register/override documented agent surfaces/providers |
| Distribution | npm modules plus Cordis loader/config conventions | npm/git/local Pi packages, pinning and filters |
| Security boundary | None | None; project trust delays local loading |
| UI integration | Generic Vue WebUI plugin ecosystem | TUI API; RPC exposes portable dialogs/events to another UI |

### Inference

For a Pi backend, Pi extensions are the natural **agent capability ABI**. Cordis should not wrap every Pi extension one-for-one: doing so creates duplicate discovery, configuration, reload, error, and ownership semantics. If Cordis is used, restrict it to host-level services that Pi does not own (desktop windows, updater, connectors, scheduler, process supervisor), and expose a narrow adapter service for the Pi process.

## Desktop-host implications

### Recommended process boundary

```text
Untrusted web renderer
        │ typed IPC through narrow preload
        ▼
Desktop main process (window, tray, updater, secure storage)
        │ spawn + strict JSONL / authenticated loopback transport
        ▼
Pi agent process (sessions, model calls, tools, Pi extensions)
        │ optional per-plugin/job boundary
        ▼
Sandbox worker/container (generated or untrusted code)
```

**Verified basis:** Pi documents RPC expressly for embedding in applications, IDEs, and custom UIs, with commands, responses, streamed events, and extension UI requests. [Pi RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)

**Inference:** a subprocess is preferable to same-process `AgentSession` for the desktop default. It provides crash containment, clearer logging/restart, and a place to apply OS restrictions. It is still not a complete sandbox, but it avoids loading agent or generated plugin code into Electron’s privileged main process. A renderer should never import Cordis/Pi plugins directly. If an HTTP/WebSocket server is used, bind to loopback, authenticate every connection, reject arbitrary origins, and avoid exposing secrets or filesystem paths through generic RPC.

Cordis can supervise this topology, but it does not supply it. Its server/WebUI packages are optional building blocks, not an Electron/Tauri host. Conversely, Pi RPC already covers the most important backend/UI seam, reducing the need for Cordis in an MVP.

## Security and trust for chat-generated plugins

### Verified facts

- Cordis context/service isolation does not isolate code execution; plugins share the host JavaScript/Node environment. [`packages/core/src/context.ts`](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts)
- Pi states that extensions execute arbitrary code with full system access, packages may run executables, and third-party source must be reviewed. Project trust delays project-local extension loading but is not a sandbox. [Pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [Pi package docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- DSH has explicit sandbox and approval-policy capabilities, illustrating that policy/execution confinement belongs in dedicated services rather than Cordis isolation itself. [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

### Required product controls (inference)

“Create/install through chat” must be a staged workflow, not `write file → import file`:

1. Generate into a quarantine workspace with no autoload path.
2. Produce a manifest of requested capabilities (filesystem roots, network hosts, subprocess, credentials, UI, persistence).
3. Pin dependencies and source revisions; run static checks, typecheck, tests, secret scanning, and dependency policy checks.
4. Show the user a diff, capability summary, provenance, and explicit install/enable confirmation.
5. Run first in a disposable process/container with synthetic credentials and a restricted workspace.
6. Install atomically; retain the previous version and support disable/rollback without starting the plugin.
7. Keep generated plugins out of desktop main/preload/renderer processes. Broker secrets and privileged actions through narrow, auditable RPC.
8. Require separate confirmation for privilege expansion on update. Never treat model authorship as trust.

Permission manifests improve review and mediation but are not enforcement unless the process/OS/container boundary actually denies undeclared operations. Prompt-based restrictions and Cordis service injection alone are insufficient because plugin code can import Node APIs directly.

## Maturity and maintenance signals

### Verified facts

- Cordis’s README says it is under active development and that its API is not stable. Core is `4.0.0-rc.8`; loader is `1.0.0-rc.5`. [Cordis README](https://github.com/cordiverse/cordis), [`packages/core/package.json`](https://github.com/cordiverse/cordis/blob/main/packages/core/package.json), [`packages/loader/package.json`](https://github.com/cordiverse/cordis/blob/main/packages/loader/package.json)
- The repositories include CI workflows and substantial unit-test trees for core, loader, HMR, server, and related packages. [Cordis repository](https://github.com/cordiverse/cordis), [Cordis server repository](https://github.com/cordiverse/server)
- The WebUI and server are separately versioned; their current peer ranges shown in manifests target Cordis release candidates. [WebUI client manifest](https://github.com/cordiverse/webui/blob/main/packages/client/package.json), [server manifest](https://github.com/cordiverse/server/blob/main/packages/core/package.json)
- DSH is itself a developer preview with expected compatibility-breaking changes. Its root package is `0.1.1-rc.2`, and it vendors/pins a Cordis snapshot plus a long local patch log. [DSH README](https://github.com/deepseek-ai/deepseek-harness), [DSH `package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json), [DSH vendor manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md)
- Pi has a documented extension/package/RPC surface and a published package manifest at `0.84.3`; this is a stronger direct fit signal, not a promise of API stability. [Pi coding-agent manifest](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/package.json)

### Assessment

Cordis shows active engineering and serious lifecycle testing, but its explicit instability and DSH’s need to carry framework patches make **version drift and ownership** material risks. A production adopter should pin exact versions, test unload/reload/failure paths, and budget for either upstream participation or vendoring. Popularity/stars were deliberately not used as architectural evidence.

## Concrete findings and risks

| Severity | Finding | Relevant source path | Consequence |
| --- | --- | --- | --- |
| **High** | Cordis “isolation” is name/service isolation, not code confinement. | `cordiverse/cordis/packages/core/src/context.ts` | Chat-generated plugins can access the host unless separately sandboxed. |
| **High** | Pi extensions also execute with full system access. | `badlogic/pi-mono/packages/coding-agent/docs/extensions.md`, `docs/packages.md` | Chat installation requires quarantine, review, explicit consent, and process/OS enforcement. |
| **High** | Cordis and DSH publicly warn of breaking changes; DSH carries extensive Cordis patches. | `cordiverse/cordis/README.md`, `deepseek-harness/README.md`, `deepseek-harness/vendor/README.md` | Pin/vendor and maintain compatibility tests; avoid making MVP depend on loader internals. |
| **Medium** | Pi and Cordis overlap in events, plugins, hot reload, configuration, and packages. | Pi extension/package docs; Cordis core/loader | Wrapping Pi plugins in Cordis risks duplicated state and unclear lifecycle ownership. |
| **Medium** | Cordis WebUI is a generic Vue/Koishi-console-derived ecosystem, not a desktop shell. | `cordiverse/webui/packages/client/package.json` | Product-specific chat/computer UI and secure desktop IPC still need implementation. |
| **Medium** | A loopback HTTP/WebSocket UI expands the local attack surface. | `cordiverse/server/packages/core/package.json`; DSH web docs | Require authentication, origin checks, random ports/tokens, and minimal APIs. |
| **Low** | Cordis effects provide unusually clean teardown and replacement semantics. | `cordiverse/cordis/packages/core/src/fiber.ts` | Useful for long-lived host connectors/schedulers if carefully bounded. |

## Recommendation and alternatives

### Recommended: Pi-native backend with a thin desktop host

Use Pi’s extension/package model for agent behavior. Spawn Pi in RPC mode from the desktop main process, translate its event stream into application state, and implement a narrowly scoped plugin manager that installs only reviewed, pinned Pi packages. This minimizes semantic duplication and follows Pi’s documented embedding seam.

Cordis may be introduced later for **host-only** composition if concrete needs emerge—hot-swappable connector providers, scheduler backends, or lifecycle-heavy local services—but should remain outside the renderer and should not imply security isolation.

### Alternative A: adopt/fork DSH rather than assemble stock Cordis

Choose this if “everything is replaceable,” durable event-sourced sessions, config-layer patching, sandbox/provider seams, and browser UI are more important than retaining Pi as the canonical backend. DSH already supplies the coherent Cordis architecture, but it is a rapidly changing developer preview and would make Pi an adapter rather than the center.

### Alternative B: stock Cordis as the whole host

Reasonable only with a commitment to a Cordis-native service graph and exact-version pinning. Avoid mixing Cordis loader distribution with Pi package distribution; define one as authoritative. Expect to build the desktop bridge, security boundaries, and product UI independently.

### Alternative C: minimal custom host registry

For a small MVP, use plain typed interfaces plus `AbortController`/disposer stacks around Pi RPC. This lacks Cordis’s dynamic dependency reconciliation but has the smallest dependency and conceptual surface. Add Cordis only after measured lifecycle complexity justifies it.

## Decision matrix

Scores: 1 = poor, 3 = acceptable, 5 = strong. “Security” scores architectural containment, not merely permission prompts.

| Option | Pi fit | Lifecycle/composition | Desktop integration | Safe generated-code path | Stability/ownership | MVP speed | Total / 30 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Pi RPC + thin desktop host (recommended)** | 5 | 3 | 5 | 3 | 4 | 5 | **25** |
| Pi RPC + Cordis for host-only services | 5 | 5 | 4 | 3 | 2 | 3 | **22** |
| Fork/adopt DSH; adapt Pi behind a seam | 2 | 5 | 3 | 4 | 2 | 2 | **18** |
| Stock Cordis as whole app foundation | 2 | 5 | 2 | 2 | 2 | 2 | **15** |
| Same-process Pi `AgentSession` + custom host | 5 | 3 | 4 | 1 | 4 | 5 | **22** |

The same-process option is fast but scores poorly for generated-code containment. DSH’s higher security score reflects explicit sandbox/approval seams, not automatic safety from Cordis.

## Small proof-of-concept plan

**Goal:** decide whether Cordis adds enough host lifecycle value without putting the MVP on its unstable loader surface.

1. **Pi desktop seam (2–3 days).** Build a minimal desktop window with narrow preload IPC. Spawn `pi --mode rpc --no-session`, send one prompt, stream assistant/tool events, and implement RPC confirmation dialogs. Verify restart, cancellation, malformed JSONL, and child-process crash recovery.
2. **Safe generation flow (2 days).** Ask Pi to generate a trivial extension in quarantine (for example, a read-only clock tool). Typecheck/test it, display diff + capability manifest, require explicit approval, then atomically copy into a test profile. Verify disable and rollback without executing the candidate in the desktop process.
3. **Cordis spike (1–2 days).** In a separate branch, use pinned Cordis core only—not WebUI/loader—to model `piProcess`, `connector`, and `scheduler` services. Replace `piProcess` and unload/reload a connector while recording effect cleanup. Test missing injection, failed async setup, cleanup failure, and rapid restart.
4. **Isolation experiment (1 day).** Run the generated extension in (a) Pi’s normal process and (b) a restricted worker/container. Demonstrate that Cordis `isolate()` does not prevent direct filesystem/network access, while the external boundary does.
5. **Exit criteria.** Adopt host-only Cordis only if it measurably removes bespoke lifecycle code, every resource is disposed after repeated reloads, and version pinning is acceptable. Otherwise retain the thin host. Do not approve chat installation until the quarantine/review/rollback and enforced execution boundary pass adversarial tests.

## Sources

### Kept (primary)

- [Cordis repository](https://github.com/cordiverse/cordis) — official status, packages, tests, and instability warning.
- [Cordis context](https://github.com/cordiverse/cordis/blob/main/packages/core/src/context.ts) and [fiber](https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts) — authoritative runtime behavior.
- [Cordis loader entry](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/config/entry.ts) and [loader](https://github.com/cordiverse/cordis/blob/main/packages/loader/src/index.ts) — authoritative configuration/mount behavior.
- [Cordis WebUI](https://github.com/cordiverse/webui) and [server](https://github.com/cordiverse/server) — official optional UI/network packages.
- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md), and [vendor manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md) — official use of Cordis and recorded divergence.
- [Pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [package docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md), and [RPC docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) — official Pi extension, distribution, trust, and host APIs.
- [xAI Grok Bot announcement](https://x.ai/news/introducing-grok-bot) — official description of the target product experience.

### Dropped

- Unofficial Grok Bot reconstructions, ports, shims, and open-source alternatives — potentially informative but excluded by the primary-source requirement and not identifiable as original source.
- Blogs, social posts, search summaries, package galleries, and Reddit discussions — secondary evidence or redundant.
- GitHub stars alone — weak evidence of runtime suitability or maintenance quality.

## Gaps

- No official original Grok Bot implementation/source was identifiable, so its desktop process model, plugin mechanism, and internal trust controls cannot be verified.
- This was source/document research, not a runtime benchmark. Cordis reload behavior, Pi RPC latency, Electron packaging, and OS sandbox behavior still require the proposed proof of concept.
- Cordis and DSH are moving rapidly; exact versions and vendored diffs should be rechecked immediately before adoption.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The report contains concrete, severity-ranked findings with authoritative repository file paths in the 'Concrete findings and risks' table, plus inline primary-source URLs throughout."
    }
  ],
  "changedFiles": [
    "docs/research/cordis-fit.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web_search: four-angle primary-source discovery for Cordis, DSH, Pi, and Grok Bot",
      "result": "passed",
      "summary": "Identified official Cordiverse, deepseek-ai, badlogic/pi-mono, and xAI sources; excluded secondary and unofficial Grok repositories."
    },
    {
      "command": "fetch_content/get_search_content: inspect official runtime source, manifests, and architecture/security docs",
      "result": "passed",
      "summary": "Verified Context/Fiber/Loader behavior, DSH vendoring and patching, Pi RPC/package security, and Cordis WebUI/server scope."
    }
  ],
  "validationOutput": [
    "Markdown written to the exact required artifact path.",
    "Verified-fact and inference sections are explicitly separated.",
    "Report ends with a decision matrix, proof-of-concept plan, primary-source audit, gaps, and this acceptance report."
  ],
  "residualRisks": [
    "No runtime proof of concept or benchmark was executed.",
    "No official original Grok Bot source was identifiable.",
    "Fast-moving Cordis, DSH, and Pi versions may change after this review."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a primary-source architectural fit assessment of Cordis for a Pi-backed extensible Grokbot desktop clone, including security risks, alternatives, decision matrix, and POC plan.",
  "reviewFindings": [
    "high: cordiverse/cordis/packages/core/src/context.ts - service isolation is not a code-execution security boundary.",
    "high: badlogic/pi-mono/packages/coding-agent/docs/extensions.md - Pi extensions execute arbitrary code with full system permissions.",
    "high: deepseek-harness/vendor/README.md - DSH depends on a pinned, materially patched Cordis fork, increasing adoption and maintenance risk.",
    "no document blockers"
  ],
  "manualNotes": "Research-only change; tests are proposed but were not run. No files were staged."
}
```
