# The re-orientation

FrockBot grew a distributed capability operating system around a product that needed a well-built app. Every capability became a Package, the app itself became a 51k-line "plugin", the client split across Vue, Flutter and a third UI language, and the agent loop braided provider I/O together with durable resumption in one 1,785-line function.

This document is the plan to reach the architecture described in [`architecture.md`](architecture.md). It replaces the ADR set, which recorded how the previous shape was reached and is available in git history.

## Target

|                  | Before                                           | After                                   |
| ---------------- | ------------------------------------------------ | --------------------------------------- |
| Packages         | 74, of which 44 plugins                          | ~7 modules                              |
| Clients          | Vue + Flutter + A2UI                             | Flutter, plus web sign-in and marketing |
| Agent loop       | 1,785 lines, provider I/O and durability braided | ~300-line durable loop over the AI SDK  |
| Plugin runtime   | cordis, 158 import sites                         | frock-compose                           |
| Applet authoring | on the User's Computer, via Miniflare            | a cloud build service                   |
| Untrusted code   | every package treated as untrusted               | Bot-authored code and Applets only      |

The seven modules: `core`, `app`, `frock-compose`, `providers`, `computer`, `applets`, `native`.

## Decisions

Settled, and not to be relitigated without a reason that is new:

- **Bot-authored packages stay.** Self-modification is the product, so the loader, generations and grants survive — scoped to untrusted code rather than applied to everything.
- **A tenant is a User.** One frock-compose client per account. Per-Bot scoping is a later addition, not a correction; a Bot authoring a plugin makes it available to that User's Bots, which is what account-shaped configuration already means.
- **The base has no DI container.** Ordinary imports. This is what stops the collapse from quietly undoing itself.
- **The Computer stays, as a Package.** One provider-neutral `ComputerHost` interface with Fly behind it, so another host can be substituted. It leaves the Applet authoring path entirely.
- **Applets follow cloudflare-os.** Source in object storage, built by a cloud service, mounted from an immutable artifact into a Durable Object facet. The runtime is already correct; only authoring moves.
- **Providers go through the AI SDK.** Request translation, streaming, tool-call accumulation and usage reporting are bought, not written, behind one narrow `ModelProvider` interface.
- **At-most-once by idempotency key.** Forensic reconciliation of dispatched effects is removed.
- **Multi-bot stays.** A single default avatar for now; the wearable system is deferred, not deleted.
- **Vue is deleted per surface**, in the same change that lands its Flutter replacement, so `main` always ships a working product.
- **Frock Compose is ours.** The `@frockbot/compose-*` packages carry no upstream provenance and are not tracked against another repository. They are free to diverge — which is what makes the Flutter `ViewNode` renderer a first-class part of them rather than a fork.

## Order

Each step leaves `main` shippable.

**1. Documentation reset.** _Done._ One page of principles, one architecture document, this plan. The ADR set, the slice plans and the superseded research are removed.

**2. Cut what is dead.** _Done._ The Electron and WebView shells, their capability packages, the architecture checks and two prototypes: 11 packages, 14,548 lines.

**3. Park the deferred features.** _Done._ MCP and Composio came out first — roughly 11.4k lines, no owned Durable Object class and no owned tables. They return later as plugins over the `http` grant, which is what they should have been.

The same ruling cleared two leftovers from that cut: Bot templates carried an `mcpServers` field and Routines a connection-trigger kind whose only provider was Composio, both kept only because changing a stored shape looked like a migration. Both are gone, along with the trigger path they served.

`plugin-voice` and `plugin-billing` are out too, in their own tag. Voice owned the `VoiceSession` Durable Object class; a `deleted_classes` migration retires it, because a `new_sqlite_classes` entry is immutable once applied.

**4. Providers onto the AI SDK.** _Done._ Replace the hand-written provider stack with one interface over `ai` + `@ai-sdk/*`. The AI SDK's OpenAI-compatible model now owns SSE framing, tool-call accumulation and the non-streamed body; request mapping, failure classification and the deadlines stayed, because the Frock AI gateway and Ollama's native endpoint reach that seam with a stream and no URL. An Anthropic provider proves the seam is open — the provider set was a hardcoded two-entry map. The 2,526-line Ollama connection file is untouched: it is durable-record ceremony, not transport, and belongs to step 7.

**5. Split the agent loop.** _Done._ `index.ts` is 853 lines beside `model-request.ts`, `resume.ts`, `tool-execution.ts`, `errors.ts` and `runtime.ts`. The extraction changed no test, which is what proved it changed no behaviour.

Forensic reconciliation is gone. Every external effect that matters carries an idempotency key — a model call's `requestId`, a tool call's `occurrenceId` — and is re-issued under that key rather than investigated afterwards. No Turn parks waiting for a person to resolve it. `admitEffect` and supersede fencing survive and now run before every dispatch, re-issues included.

The seam that retrieved a lost response from the provider is deleted outright: `LlmReconciliationCapability`, `ctx.llm.reconcile`, and all four provider implementations. It was declared, implemented everywhere and called by nobody.

**6. Frock Compose replaces cordis.** _In progress, in three cuts that each leave `main` shippable._ Wire the extension points named in `AGENTS.md` — and only those — and delete `kernel-composition`, the manifest system, `plugin-authoring`, `plugin-package-catalog` and `plugin-package-publisher`.

- _6a, done._ The three packages, with the seams that existed only for them: the Bot authoring quota and artifact store, the Catalog install path, the publisher's User revisions, and `apps/cloudflare-bundler`, whose one caller was authoring. 14,900 lines. Authoring returns with the step 8 build service; nothing else produces an artifact-bearing member now, so the only isolate member is the Applets Package.
- _6b, done._ cordis is gone. The registries are plain classes built by ordinary imports; every first-party plugin is a feature function the app lists in order; the loop takes one typed hook list (`LoopHooksV1`) that replaces the waterfall and emit bus, and the isolate host appends a Bot-authored package's hooks to the same list after the app's. The resident runtime, the desktop shell contracts and the two `@cordisjs/plugin-webui` entries went with it: none had a live caller. The manifests stay until 6c.
- _6c, done._ Frock Compose hosts the untrusted layer only. The Package Catalog went first: first-party code ships with the deploy, so it had nothing to distribute. The Applets tools became an ordinary first-party feature with first-party iframe pages, and the Worker Loader host moved into `compose-frockbot`. Then the manifests went: a first-party plugin is a `PackageDefinitionV1` the foundation lists, and an untrusted member carries a `PluginDescriptorV1` naming its tools, the six actions, the grants, the slots and the three context keys — nothing else. Generations list untrusted members only and live in `core/durable`; `kernel-composition` is deleted. Nothing produces an untrusted member until the step 8 build service exists, so tests are the narrowed contract's only caller for now.

**7. Collapse the plugins into the app.** _Done._ The 21 first-party plugins are directories under `app/`, and the seven modules are what is on disk: `core`, `app`, `providers`, `computer`, `applets`, `native`, and Frock Compose as `packages/compose-core` and `packages/compose-frockbot` until its own cut. `applications/` is gone, and the eight per-plugin vite builds went with it — nothing read their output, and the app's own build bundles the clients from source.

The shell backend is now a state object and feature modules: `ShellBotStateV1` is what every feature function takes as its first argument, and each group — Subagents, isolate grants, the Applets host, settings, notifications, routines, approvals, the machine seam, run reads, debug, Skills, the Turn and its Composition mount — is an ordinary exported function the Bot Durable Object calls directly. `app/shell/backend.ts` went from 6,111 lines to 204: the state construction, a hook table of one-line lambdas, and the forwards the recovery tests still drive.

**8. Applets off the Computer.** _In progress, in four cuts that each leave `main` shippable._ A build service takes source, type-checks, lints, bundles and returns a content-addressed artifact with a preview URL. The durable-root sync leaves the Applet path.

- _8a, done._ The build service, dark. `apps/applet-build` is a fifth deployable: no routes, an `APPLET_BUILD` service binding, a `node:24-slim` container with no egress that runs the SDK's own pipeline, and a shared token both the Worker and the container check. `applets/build-contract.ts` is the wire protocol; the reusable bodies of `applet check` and `applet build` moved to `applets/sdk/src/build/`, so the CLI and the service run one implementation and a test asserts they hash alike. That test found a real defect on the way: esbuild writes each module's path into the unminified server bundle, so identical source built in two directories produced two content hashes — every publish of unchanged code would have written a new R2 object. The paths are now stable labels. Nothing in the app calls the binding: `applet_publish` still reads `dist/` off the Computer.
- _8b._ Source off the Computer: publish reads the source prefix and calls the service, and the Bot gets `applet_write_file`, `applet_read_file` and `applet_check` in place of the four shell steps.
- _8c._ The durable-root sync leaves the Applet path.
- _8d._ The dead code out: the Sprite's `applets` provisioning phase, the `applet` shim, the two doctor checks, and the CLI reduced to a front end.

**9. Flutter to parity, Vue out.** The long pole. One Flutter client, on the phone and on the web — `bot.frockbot.com` is an app behind sign-in, so Flutter Web's first-load cost buys one codebase instead of two. Each surface ported, then its Vue original deleted in the same change. Includes the ViewNode renderer — six node types — which replaces A2UI as the way a plugin renders.

**10. Narrow the Computer.** Extract Fly from `computer/` and `apps/computer-host` behind the `ComputerHost` interface, so a k8s host is an implementation rather than a rewrite.

## Not now

Voice, billing, package publishing, per-Bot plugin scoping, avatar wearables, and Applet sharing between Users. Each is an addition to the target, not a change to it.
