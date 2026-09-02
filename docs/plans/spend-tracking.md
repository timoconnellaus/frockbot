# Spend tracking

Exploration and design for metering what a User costs FrockBot to run. Payments
(Stripe) are deliberately out of scope here and depend on this landing first;
the closing section says why.

Three cost surfaces are in scope: **Computers** (Fly Sprites), **Bot isolates**
(Cloudflare Dynamic Workers, loaded through the `worker_loaders` bindings), and
**models** (Workers AI through the `AI` binding, plus every other provider
Package behind the same model interface).

## The shape the constitution already forces

Four rules in `AGENTS.md` decide most of this design before any code is written.

- "The User's Durable Object is the authority for everything User-scoped: ...
  quotas" (Authorities). The spend ledger is User-scoped, so it lives in the
  User Durable Object.
- "Generation creation rate, artifact size, retained generations, Workspace
  disk, and Bot isolate CPU, subrequests, and **model spend** are bounded by
  durable per-User quotas" (Package composition). Spend metering is not a new
  concept being bolted on; it is the missing half of a quota the constitution
  already names.
- "The kernel imports no Package and contains **no product policy**" (Minimal
  kernel). A price is product policy. The kernel and the Durable Objects carry
  raw, un-priced unit counts; converting units to money happens in a Package.
- "Provider-specific authentication, request translation, streaming
  normalization, **usage reporting**, and errors stay inside that Plugin"
  (Plugin-owned integrations). Each provider Package reports its own usage
  through a kernel-declared DTO; the kernel never parses a provider's response.

That gives a three-layer split, and every decision below follows from it:

| Layer      | What it holds                    | Where it lives                                    |
| ---------- | -------------------------------- | ------------------------------------------------- |
| **Meter**  | raw units, no money              | the seam where the effect happens (provider Package, isolate host, Computer provider) |
| **Ledger** | durable, idempotent, per-User    | the User Durable Object (rollups) + the Bot session event log (raw readings) |
| **Rate**   | units → money                    | a first-party `plugin-billing` Package            |

Keeping Rate out of the kernel is not pedantry. Cloudflare re-prices Workers AI
models and Fly re-prices compute; a price change must be a Package generation,
not a kernel deploy.

## Prior art to copy, not reinvent

`packages/plugin-authoring/src/quota.ts` already solves the hard half of this:
a durable per-User counter in the User Durable Object, a narrow RPC the Bot
Durable Object calls, idempotency keyed on the effect id, and a
`storage.transaction` wrapping the read-modify-write so two concurrent
reservations at the limit cannot both admit. Its comment says exactly why:

> the read-modify-write spans awaits, so two concurrent reservations at the
> limit must not both see the same count.

The spend ledger is the same module with a different payload. Reuse the key
layout (`quota:` → `spend:`), the receipt-is-recorded-even-on-refusal rule, and
the transaction discipline verbatim. Reservations there become **recordings**
here — spend is observed after the fact, not reserved before it — but the
idempotency requirement is identical, because a resumed Turn re-executing the
same effect must not double-count.

## The meter DTO

One versioned shape for all three surfaces, decoded at its seam
(Explicit seams). Sketch, to be pinned down in `kernel-contracts`:

```ts
export type MeterKindV1 = "model" | "isolate" | "computer";

export type MeterUnitV1 =
  | "input-tokens" | "cached-input-tokens" | "output-tokens"  // model
  | "invocations" | "cpu-ms" | "subrequests" | "wall-ms"      // isolate
  | "compute-seconds" | "stored-bytes";                       // computer

export interface MeterReadingV1 {
  schemaVersion: 1;
  meter: MeterKindV1;
  /** Idempotency key. A replayed effect records the same reading once. */
  effectId: string;
  userId: string;
  botId: string;
  sessionId: string;
  turnId: string;
  step: number;
  at: string;
  /** What was consumed: a model id, a loader binding, a sprite name. */
  resource: string;
  units: Array<{ unit: MeterUnitV1; quantity: number }>;
  /** Platform-funded spend is billable; a User's own key is not. */
  funding: "platform" | "user-connection";
  /** How the number was obtained. Never round this up to "measured". */
  confidence: "measured" | "bounded" | "estimated";
}
```

Two fields carry most of the design weight.

**`funding`** exists because of the branch this repo is already on. A User who
attaches their own Ollama Cloud or OpenAI-compatible Connection pays the
provider directly. That spend is still worth metering — it is the User's usage
picture — but it must never reach an invoice. Deciding this at the meter, not
at the invoice, means no rating bug can ever bill a User for their own key.

**`confidence`** exists because exactly one of the three surfaces can be
measured exactly today. Recording `bounded` or `estimated` honestly is what
makes the shadow-mode calibration below possible; a ledger that pretends to
measure what it estimates cannot be reconciled against a real invoice.

## Surface 1 — models

**What is available.** Workers AI returns a `usage` object on the response
(`prompt_tokens`, `completion_tokens`, `total_tokens`, plus cached-token counts
when prompt caching hits). Pricing is per-model in neurons per million tokens,
at $0.011 per 1,000 neurons. So this surface is fully **measured**, and the
neuron table is a Package-owned rating table.

**What is missing in this repo.** `packages/provider-openai-compatible/src/index.ts`
streams the completion and discards usage entirely — it sets `stream: true` and
never sets `stream_options: { include_usage: true }`, so the final usage chunk
is never requested. `LlmStreamEvent`'s `finish` event in
`packages/kernel-contracts/src/types.ts` carries only a reason, so there is no
place to put usage even if it were parsed. And the session event map has no
usage event: `assistant/message` records text and tool calls, nothing about
cost.

**Design.**

1. Widen the kernel's `finish` stream event to carry an optional
   `MeterReadingV1`. The kernel stays provider-neutral — it forwards a reading
   it does not interpret, which is exactly what "usage reporting stays inside
   that Plugin" asks for.
2. Each provider Package fills it: Workers AI from `response.usage`;
   openai-compatible from the `include_usage` final chunk; ollama-cloud
   likewise, with `funding: "user-connection"`.
3. When a provider genuinely cannot report (an older endpoint that ignores
   `stream_options`), estimate from character counts and mark
   `confidence: "estimated"`. Never silently emit zero.
4. New session event `model/usage { turn, step, requestId, reading }`, so the
   Bot Durable Object's log — already the record from which "every exact
   normalized model request" is reconstructable — also reconstructs what each
   request cost.

**The ADR 0010 interaction.** An abandoned or unretrievable model effect has
consumed provider tokens that FrockBot will never see. Recording zero would be
a silent under-count. Record a `model/usage-unknown { requestId, reason }`
event instead, so the gap is visible in durable state — "failures are
observable through durable state" (Durable effects). The reconciliation job
below can then attribute the difference between metered and invoiced spend to a
countable set of known-unknown requests rather than to a mystery.

## Surface 2 — Bot isolates

**What is available.** Dynamic Workers requests and CPU time bill at Workers
Standard rates, where CPU time is startup (isolate init and code parse) plus
execution (excluding I/O wait). The per-daily-creation dimension is documented
but not currently charged. `BotIsolateHostOptions` in
`packages/kernel-composition/src/isolate-host.ts` already sets
`limits: { cpuMs, subRequests }`, defaulting to 5,000 ms and 5.

**The honest constraint.** There is no per-invocation CPU readout returned to
the caller. A Dynamic Worker that exceeds `limits.cpuMs` throws; one that stays
under it reports nothing. So the isolate host cannot measure what it spends.

**Design — meter what is measurable, and label the rest.**

- `invocations` — **measured**, counted in `BotIsolateContributionHost`.
- `wall-ms` — **measured**, but it is wall time, which includes I/O wait and so
  over-states CPU. Useful as an allocation weight, not as a cost.
- `cpu-ms` — **bounded**. Record the configured `limits.cpuMs` as a ceiling,
  not as a consumption. A CPU-limit exception is a discrete, separately
  recorded breach.
- `subrequests` — **bounded** the same way, unless the host starts counting
  outbound calls through the capability bindings itself, which it could: every
  isolate subrequest goes through a kernel-minted binding, so the kernel is in
  a position to count them exactly. That is the one place a small amount of work
  converts `bounded` into `measured`, and it is worth doing.

**Truth-up.** Fold actual CPU in from outside: either the Workers GraphQL
Analytics API per-script, or an Analytics Engine `writeDataPoint` from the
isolate host that a scheduled job aggregates. The delta between the account's
actual Workers CPU and the sum of metered wall time becomes a per-User
allocation, weighted by `wall-ms`. Record the truth-up as its own ledger entry
so the estimate and the correction are both visible rather than one quietly
overwriting the other.

## Surface 3 — Computers (Fly Sprites)

**What is available.** Sprites bill compute only while a Sprite is active, and
storage on bytes actually written rather than provisioned capacity (each Sprite
gets 100 GB). Idling is automatic and two-stage — warm (VM suspended, compute
billing stops, fast wake) then cold (in-memory state dropped, slow wake). Wake
is automatic on any command or URL request.

**The honest constraint, and it is the sharpest of the three.** FrockBot never
issues start or stop. A Sprite wakes because someone exec'd or hit its URL, and
idles on a schedule FrockBot does not control and is not notified about. The
API surface exposes service start/stop and exec, not a per-Sprite usage or
billing endpoint. **The backend therefore cannot derive awake-seconds from its
own actions.** Any design that claims to is wrong.

**Design.**

- **Attribution is clean even though measurement is not.** ADR 0012 gives one
  Computer per User and `flySpriteNameForComputer` derives the Sprite name from
  the userId, so every Sprite maps to exactly one User. Per-Bot attribution is
  best-effort from the tenant directory, which matches the constitution's
  "separation between Bots on a Computer is organizational, not a security
  boundary".
- **`compute-seconds` — estimated.** The provider Package already records
  intent before every Computer effect (required by "Computer effects are
  reconcilable"), and `computer.ts` already touches a `last-seen` file while
  `host.ts` runs a heartbeat. Together those bound an awake window: from first
  touch to last-seen plus the idle grace period. That is an estimate, and it
  is labelled one.
- **`stored-bytes` — measured.** The workspace sync knows generation sizes, and
  a periodic `du` of the durable roots gives actual written bytes. This is the
  cheapest accurate number on this surface, and since storage is billed on
  bytes written it may well be the larger line item for a mostly-idle Computer.
- **Reconciliation is mandatory here, not optional.** Pull the Sprites/Fly
  organization invoice on a schedule and allocate it across Users pro-rata by
  metered awake-time. Until that job exists, treat Computer spend numbers as
  directional only, and say so in the UI.

## The ledger

In the User Durable Object, mirroring `quota.ts`:

- `spend:config` — durable per-User configuration, including the caps that will
  later satisfy the constitution's "model spend ... bounded by durable
  per-User quotas".
- `spend:day:<yyyy-mm-dd>` — rolled counters, keyed by `meter`, `unit`,
  `funding`, and `confidence`. Calendar-day UTC keys, same as
  `authoringQuotaDayV1`.
- `spend:reading:<effectId>` — the idempotency record. A replayed effect
  returns the recorded receipt and does not increment.
- `SpendLedgerBinding { record(reading: MeterReadingV1): Promise<SpendReceiptV1> }`
  — the narrow RPC the Bot Durable Object calls, wrapped in
  `storage.transaction` for the same reason the authoring quota is.

**Retention.** Raw readings stay in the Bot session event log, which is already
append-only and already the reconstruction record. Only rollups live in the
User Durable Object, which keeps its storage bounded. If per-reading query
becomes a UI requirement, Analytics Engine is the read surface, never the
authority.

**Why recording, not reserving.** Authoring quota reserves before the effect
because it can refuse. Spend is observed after the effect completes, so the
ledger records. When enforcement arrives it becomes a hybrid: check the
day's counter before admitting a Turn (cheap, slightly stale) and record after
each step. That is deliberately deferred — a cap that fires mid-Turn is a much
harder product question than a cap that refuses admission.

## Constitutional gate

One item needs a human decision before implementation, per the Feature rule's
requirement that every feature name "the parity-register item it matches, or
its explicit label as beyond parity".

The parity register (`docs/research/grokbot-computer.md`) lists GrokBot's
per-user settings including a **Usage & Billing** panel (plan, cancel-trial,
on-demand; account-gated), but has no numbered row for a spend meter. Row 57h
covers a Bot requesting a virtual payment card, which is a different feature.

**Recommended resolution:** add a register row for the Usage & Billing surface
and treat the meter as the backend that row requires. The alternative —
labelling spend tracking explicitly beyond parity — is defensible but
understates that GrokBot ships a usage panel FrockBot will need to match.

Nothing else in this design conflicts. Pricing stays out of the kernel, usage
reporting stays in provider Packages, the ledger sits in the authority the
constitution assigns it, and the per-User quota it enables is one the
constitution already names.

## Sequencing

Vertical slices, each shipping a working read-out rather than infrastructure
with no consumer.

1. **Meter DTO + ledger + the one measured surface.** `MeterReadingV1` in
   `kernel-contracts`, the `spend:` ledger in the User Durable Object,
   `model/usage` session events, Workers AI usage wired through, and a settings
   panel showing token counts per day. End-to-end and honest on day one.
2. **The other model providers.** `stream_options: { include_usage: true }` in
   the openai-compatible provider, ollama-cloud reporting with
   `funding: "user-connection"`, and the estimated fallback. Add the
   architecture check that two provider Packages report usage with no kernel
   diff — it extends the existing "two provider Packages satisfy the model
   interface with no kernel diff" check rather than inventing a new one.
3. **Isolates.** Invocation and wall-time meters in the isolate host, exact
   subrequest counting through the capability bindings, and the Analytics
   Engine truth-up job.
4. **Computers.** Awake-window estimation, `stored-bytes` from the workspace
   sync, and the Fly invoice reconciliation job.
5. **Rating.** `plugin-billing` with the neuron table, Workers Standard rates,
   and Sprite rates. Runs in shadow mode: it computes money and shows it, and
   bills nothing.
6. **Enforcement, then Stripe.** Only after a month of shadow-mode numbers.

## Why spend tracking really does come before Stripe

Not merely because it is a prerequisite. Because two of the three meters cannot
be measured exactly, and the size of that error is currently unknown. Stripe
needs a per-User cost number that survives a customer disputing it.

Shadow mode is what earns that: meter and rate everything, bill nothing, and
each month compare rated spend against the actual Cloudflare and Fly invoices.
If metered spend tracks the invoice within a few percent, the estimates are
good enough to price against. If Computer allocation is off by half, that is
worth discovering before a customer's card is charged rather than after.

The `confidence` field is what makes that comparison possible, which is why it
is in the DTO from the first slice rather than added later.
