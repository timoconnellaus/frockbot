# FrockBot

FrockBot is a hosted product for creating and running persistent conversational Bots. A Bot holds a conversation, calls tools, remembers things, runs on a schedule, and can extend itself. The reference for what a Bot should be able to do is [`docs/grokbot-parity.md`](docs/grokbot-parity.md).

Terms are defined in [`CONTEXT.md`](CONTEXT.md). How the system is built is in [`docs/architecture.md`](docs/architecture.md). What is changing right now is in [`docs/plan.md`](docs/plan.md).

## Rigor is proportional to consequence

This is the rule the rest of the document depends on.

A model call that spends money, an external write, and the durable turn log get careful treatment: recorded intent, idempotency, explicit failure. Saving a setting does not. Match the machinery to what breaks if it goes wrong, and prefer the plainest thing that works.

When a rule below would force ceremony onto something inconsequential, the rule is wrong for that case. Say so and keep going.

## Three layers, three different words

Most of this codebase's past complexity came from calling all three of these a "Package".

**App** — the product. Ordinary TypeScript in ordinary directories: conversation, settings, audit, memory, skills, routines, bots. It is imported, reviewed and shipped like any other code. There is no dependency-injection container in the base, and no part of the product is installed, enabled or repaired at runtime.

**Package** — a swappable implementation chosen at build time, behind an interface: the Computer host, model providers, storage. A self-hoster may substitute one. Nobody swaps one at runtime.

**Plugin** — code that runs at runtime and was not there at build time: Bot-authored extensions, Applets, third-party installs. Only plugins get manifests, content-addressed artifacts, generations and isolates.

Untrusted code is the only thing that earns plugin machinery. If first-party code is being given a manifest, that is the mistake.

## Extension points

A plugin can only reach what the app deliberately opened. The full surface:

- **Slots** — where a plugin may render: composer toolbar, message actions, sidebar entries, settings sections, bot profile. Trust chrome is never a slot.
- **Actions** — behaviour a plugin may wrap: `context.assemble`, `tools.expose`, `tool.call`, `turn.terminate`, `memory.read`, `memory.write`.
- **Grants** — authority a plugin may hold: `storage`, `http` (a named service, credential attached server-side), `schedule`, `ai`, `files`, `memory`, `workspace`, `computer`.
- **Context keys** — `user`, `bot`, `session`.

Adding an extension point is a deliberate change to this list, not a side effect of building a feature.

## Invariants

These hold regardless of how the code is organised.

- **The cloud is authoritative.** Clients render state and submit commands. A client is never a second source of truth, and the Agent loop never runs in one.
- **Admit input durably before acknowledging it.** A disconnect, refresh or eviction must not lose accepted work, and only an authenticated command cancels a Turn.
- **A Turn survives eviction.** Enough state is recorded to resume; use durable scheduling rather than staying resident.
- **External effects are at-most-once by key.** Anything that spends money or writes to a third party carries an idempotency key and is retried by that key. Do not reconstruct after the fact whether an effect happened.
- **Untrusted code gets an isolate.** Bot-authored and third-party code runs in a loaded Worker with `globalOutbound` disabled and only its named grants. No ambient network, no secrets, no Durable Object storage it was not given.
- **Self-modification never widens authority.** Code a Bot writes runs with exactly what the Bot already holds. There is no path by which a Bot asks for more.
- **Artifacts are immutable and content-addressed.** They are superseded, never edited in place, and record which Bot, Session and Turn produced them.
- **A User can always see and undo.** The conversation, audit and undo surfaces are part of the app, cannot be removed by a plugin, and cannot be impersonated by one.
- **Configuration is account-shaped.** What a User enables is available to every Bot they own. Per-Bot settings exist only for what must genuinely differ: identity, instructions, notifications.
- **The product works with zero configuration.** The platform picks the model. Configuration extends reach; it never repairs a broken default.
- **Nothing is kept for compatibility.** Removing a feature removes its code, its surfaces, its stored shapes and its decoders. Do not write a migration, keep a decoder branch, or hold a field alive so an older record still parses. There are no users yet: stored state is disposable, and legacy is a cost paid for nothing. When the first real user lands, this rule changes and forward migration becomes an invariant — until then, prefer deleting the shape to versioning it. Every breaking stored-data change must include and execute a scoped, repeatable cleanup of the incompatible test data as part of its release, and verify a fresh conversation works. Do not leave unreadable records in production. Before admitting the first real user, replace this disposable-state rule with tested forward migrations; do not wait for a data-loss incident.
- **Secrets stay server-side.** They cross an interface only as opaque, expiring leases. Memory and the Workspace hold none.

## Working here

- Pre-commit formats staged files. Pre-push runs the fast tier (`format`, `typecheck`, `unit`) and reuses passes only for the exact commit with a clean code checkout; the slow tier runs on `main` after the merge. Run `bun run validate` in full when a change touches the runtime, the integration seams or the browser client, and `bun run validate:<category>` to record individual passes. See [`docs/local-validation.md`](docs/local-validation.md) for cache and GitHub operation.
- Once no-mistakes finishes, go directly to push and PR. Do not rerun the full local test suites after the gate; the PR's `Check` and, after the merge, `main.yml`'s slow tier are the next validation layers. Rerun locally only when code changes after the gate or when the gate skipped or failed a required suite.
- A branch need not be rebased when `main` moves: `main.yml` checks the merge commit itself once it lands. Rebase only to resolve a conflict, and then inspect the rebased diff rather than rerunning no-mistakes because the commits moved.
- There is no auto-merge. A green PR waits for Tim to merge it; `ci-watch.ts` reports that state as passed, and the session's work on the PR is done there.
- Documentation-only exception: when the outgoing changes contain no code, configuration, or runtime-behavior changes, skip code tests and use `git push --no-verify` without asking. Inspect the diff and check Markdown formatting first; Markdown used as a runtime prompt counts as code.
- Merging integrates; tagging ships. A green `main` cuts the next patch tag by itself, and deploys staging only when the repository variable `DEPLOY_STAGING` is `true`; production moves only when Tim approves the release run under the `production` environment. Never approve a deployment or push a version tag unless asked.
- For a full Android APK release, publish the APK and use wireless ADB to install it automatically when Tim's paired phone is reachable; this is authorized without asking again. For a Shorebird patch, verify activation without replacing the APK. Include the clickable [FrockBot APK download link](https://tims-m5-macbook-pro.tail34be3c.ts.net:8443/frockbot.apk) in the final response every time, stating whether it serves the new build or an older one. Verify the installed or published version before calling the update ready.
- Android delivery goes through Shorebird via `scripts/native-update.py` (procedure in [`apps/native/README.md`](apps/native/README.md)). Uploading compiled FrockBot builds and patches to Tim's Shorebird account is authorized. Dart-only changes ship as signed patches to the staging track after validation; native, asset, plugin or engine changes need a full APK release, and every full release is installed once as the enabling APK. Staging patches are validated on a disposable emulator only: `shorebird preview` wipes app data, so it never runs on Tim's phone, whose APK upgrades use `adb install -r`. A published patch is not evidence; confirm on the phone that the promoted change is live, and keep the APK download route working as the fallback. Every version tag ships the Android half itself: `release.yml` cuts the staging patch and promotes it with the production approval, so cut a patch by hand only for a change that is not going through a tag. Full releases are always cut by hand.
- When completing an update that changes the native client or its minimum supported version, run `bun run update:desktop` from the release checkout. It builds, verifies, safely replaces and opens `/Users/tim/Applications/FrockBot.app`. Android-only APK releases and Shorebird patches leave the desktop app unchanged.
- If you open a PR or push a tag, watch it to a terminal state with `bun scripts/ci-watch.ts` and fix what it finds. For a PR, green is the terminal state.
- Prefer deleting code to adding a flag. Git history is the archive — this repo documents how things are now, not how they came to be.
- Comment why, not what. Most code needs no comment.
