---
status: accepted
---

# Spend Is a User-Owned Priced Event Ledger

## Context

FrockBot needs one durable answer to “what has this User spent?” before prepaid
Stripe credits can be added. Provider responses are not that answer: providers
use different usage shapes, some omit usage entirely, and a Bot may run chat,
Routine, recovery, or Subagent Turns through the same model seam. Repricing old
activity whenever a vendor changes a price would also make the answer unstable.

This is beyond-parity accounting infrastructure, informed by GrokBot's visible
Usage and Billing surface. It is a prerequisite for, but does not implement,
the Stripe credit and one-time payment work associated with parity-register row
57h.

## Decision

The User Durable Object owns the usage ledger. `@frockbot/plugin-billing` is a
platform-owned Package and supplies its Bot projection, User storage, gateway,
and hosted-client Contributions; the kernel imports none of them.

Every dispatched model request produces one `model/usage` event in the Bot's
append-only session log. It identifies the Turn, step, request, provider, model,
and complete model-binding snapshot, and records input, output, cached-input,
and reasoning tokens plus end-to-end stream latency. Provider transports
normalize OpenAI token usage, Workers AI token usage, and Ollama prompt/eval
counts into the shared event. When the provider omits counts, the loop estimates
tokens as the ceiling of exact normalized-request and assembled-response UTF-8
bytes divided by four and sets `estimated: true`. A definitive
`LlmEffectNotStartedError` records no spend; a stream that may have started but
fails still records reported partial counts or an explicit estimate before its
effect moves to reconciliation.

At `agent/turn-stopping`, after the run events are durable, the Billing Package
prices each new event and appends the result to a bounded durable Bot outbox.
The same checkpoint is used for conversational, Routine, recovery, and
Subagent Turns. Delivery to the User Durable Object is at least once, retried by
the Bot alarm, and insertion is idempotent on
`botId:runId:modelRequestId`. User storage inserts the detail row, day and month
rollups, and lifetime total in one Durable Object SQL transaction. A retry
therefore either observes the existing row or applies the entry and every
aggregate exactly once.

The immutable price table version `2026-09-04` records dollars per million
input, cached-input, and output tokens for the shipped Frock AI, OpenAI-compatible,
and Ollama Cloud models. Each entry stores that version and its integer
micro-dollar result, so a later table changes only future entries. The one
platform multiplier is `1`; an unlisted provider/model uses the deliberately
conservative `$10 / $10 / $50` input/cached/output fallback and records
`unknownPrice: true`. Vendor source URLs live beside the table. Ollama's
time-of-day DeepSeek prices use its published peak rate so a static ledger does
not understate the call.

Voice usage enters the same User-owned ledger from the existing durable quota
receipt. The receipt carries cumulative session seconds; the ledger id is made
from that cumulative value while the entry charges only newly recorded seconds,
so retries are idempotent and incremental reports do not double-charge. It uses
OpenAI's published `gpt-live-transcribe` duration rate and is provider-reported,
not estimated.

Detailed rows and daily rollups are retained for 45 days and detail is also
bounded at 50,000 rows. Monthly dimension rollups survive detail eviction for
120 months, while the all-time cost remains as one lifetime aggregate. The
User report returns the current month's total and token counts, Bot and model
breakdowns, a dense 30-day series, estimate and unknown-price counts, and the
lifetime total. `GET /api/usage` exposes that report to the authenticated User;
`GET /api/debug/usage?userId=…` exposes the same projection only through the
existing development debug surface.

The hosted UI owns no accounting state. Billing contributes the Usage section
to User settings and one current-month line to each Bot's settings. Closing or
refreshing either view changes nothing. Client disconnect never cancels a Turn;
Bot eviction leaves the session event and outbox durable; User eviction leaves
the ledger and aggregates in SQL; Computer hibernation is irrelevant to model,
voice, storage, or report paths.

## Failure, authority, and recovery

The Bot can spend only through the model binding and Connections already pinned
for its admitted Turn. The ledger receives identifiers and counts, never prompt
or response content and never a credential. A missing or revoked Connection
still fails at composition/model resolution and grants nothing through Billing.

A failed User delivery leaves the Bot outbox intact and schedules another drain;
duplicate delivery is harmless. Invalid inbound entries are quarantined at the
User seam rather than partially decoded. Unknown prices and estimated usage are
visible counters, not silent substitutions. The outbox, detail table, day
series, and retained month series all have explicit durable bounds.

There is no provider-neutral, reconciled Computer activity-duration event yet.
Computer spend is therefore not guessed from a process or Turn's wall clock.
**TODO:** add Computer seconds to this ledger when the Computer interface exposes
a durable, idempotent activity or lease-duration receipt.

## Consequences

- A vendor price change requires a new table version and tests; old entries are
  never rewritten.
- The ledger can support Stripe credits later by applying credits against its
  authoritative priced entries. This decision neither creates a Stripe balance
  nor changes payment authority.
- Estimates trade invoice precision for complete visibility. They remain
  distinguishable in both durable state and the User report.
- Recovery can replay settled Turn projection or outbox delivery without
  duplicating spend, and no Computer is woken to do so.
