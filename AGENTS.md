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
- **Durable state migrates forward.** A stored record of an older shape is migrated at the seam that reads it. Removing a feature removes its code and surfaces; only the migration remains.
- **Secrets stay server-side.** They cross an interface only as opaque, expiring leases. Memory and the Workspace hold none.

## Working here

- `bun run typecheck` and `bun test` both pass before a commit. The pre-commit hook runs them.
- Merging integrates; tagging ships. Reaching `main` deploys nothing.
- If you open a PR or push a tag, watch it to a terminal state with `bun scripts/ci-watch.ts` and fix what it finds.
- Prefer deleting code to adding a flag. Git history is the archive — this repo documents how things are now, not how they came to be.
- Comment why, not what. Most code needs no comment.
