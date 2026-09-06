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
- **frock-compose is ours.** Vendored, renamed, and free to diverge. It is not tracked against upstream.

## Order

Each step leaves `main` shippable.

**1. Documentation reset.** _Done._ One page of principles, one architecture document, this plan. The ADR set, the slice plans and the superseded research are removed.

**2. Cut what is dead.** _Done._ The Electron and WebView shells, their capability packages, the architecture checks and two prototypes: 11 packages, 14,548 lines.

**3. Park the deferred features.** _Done for MCP and Composio._ They came out first — roughly 11.4k lines, no owned Durable Object class and no owned tables. They return later as plugins over the `http` grant, which is what they should have been.

`plugin-voice` and `plugin-billing` wait for a migration decision. Voice owns the `VoiceSession` Durable Object class, declared `new_sqlite_classes` in migration v5, so removing it needs a `deleted_classes` migration that destroys those objects. Billing owns three SQLite tables of User spend history inside `UserConfiguration`. Neither is a code deletion; both destroy durable state, and the retention question is the owner's.

**4. Providers onto the AI SDK.** Replace the hand-written provider stack with one interface over `ai` + `@ai-sdk/*`. Removes about 6k lines, including the 2,526-line file that exists to hold an Ollama API key.

**5. Split the agent loop.** Separate provider I/O from the durable state machine. The loop claims input, calls the model, runs tools, appends events, advances the cursor — and nothing else. Resumption becomes its own module: replay the event log to the cursor. Reconciliation and effect fencing go.

**6. frock-compose replaces cordis.** Rename the vendored packages, wire the extension points named in `AGENTS.md`, and delete `kernel-composition`, the manifest system, `plugin-authoring`, `plugin-package-catalog` and `plugin-package-publisher`.

**7. Collapse the plugins into the app.** The 21 first-party plugins become directories. The 6,096-line `ShellBotBackendContribution` becomes ordinary feature modules. `applications/foundation` goes.

**8. Applets off the Computer.** A build service takes source, type-checks, lints, bundles and returns a content-addressed artifact with a preview URL. The durable-root sync leaves the Applet path.

**9. Flutter to parity, Vue out.** The long pole. Each surface ported, then its Vue original deleted in the same change. Includes the ViewNode renderer — six node types — which replaces A2UI as the way a plugin renders.

**10. Narrow the Computer.** Extract Fly from `plugin-computer`, `plugin-fly-sprite` and `apps/computer-host` behind the `ComputerHost` interface, so a k8s host is an implementation rather than a rewrite.

## Not now

Voice, billing, package publishing, per-Bot plugin scoping, avatar wearables, and Applet sharing between Users. Each is an addition to the target, not a change to it.
