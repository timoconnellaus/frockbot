---
status: proposed
---

# A restart settles an unretrievable Turn instead of parking it

On recovery, a run whose provider outcome is unknown and whose provider offers
no retrieval is settled `failed`, keeping every word it had already streamed and
carrying a notice that says it stopped partway and can be sent again. It is
never parked as `reconciliation-required`.

## What was wrong

A Worker or Durable Object restart mid-Turn parked every in-flight run. The
recovery plan sees a `model/request` with no durable outcome, cannot know
whether the provider ran it, and — correctly, under ADR 0024's durability
contract — refuses to assume. So the run becomes `reconciliation-required`, the
Bot is held behind it, and the person gets a banner with a Resolve action.

That is the right answer when somebody can be asked. Nobody can. Ollama Cloud
exposes no provider-bound response retrieval ([ADR
0010](0010-abandon-unretrievable-model-effects.md)), and neither does Flock AI;
the only provider in this deployment that implements
`LlmReconciliationCapability` is the in-process foundation one used by tests. So
in production the park is not caution, it is a dead end: nothing will ever
arrive to resolve it, and the Resolve button's only possible outcome is the one
ADR 0010 already named — terminalize as failed, explicitly.

The cost is not theoretical. A restart is the ordinary way a Worker's life ends.
Every Turn running at that moment wedged its Bot until a person noticed a banner
and clicked through it, and PR 166's author deferred the fix precisely because
auto-resolving an uncertain outcome looks like it touches ADR 0024.

## The decision

**Uncertainty is still never assumed away — the question is who is left to ask.**
ADR 0024's rule is that an effect which may already have run is never treated as
though it did not. Nothing here weakens it: the failed Turn is not retried, its
request is not re-sent, and the record keeps the whole journal, so a duplicate
model call is as impossible as it was before. What changes is only what the
Bot does while waiting for an answer that is not coming.

**The provider's retrieval is a static fact, read from the run's own journal.**
Recovery takes the `provider` off the run's most recent durable `model/request`
and asks one synchronous predicate whether that provider reconciles. It has to
be synchronous and pure because it is consulted inside the transaction that
settles the run, where nothing may be mounted or awaited; and it has to come
from the journal rather than from anything resident, so that every recovery of
the same run reaches the same conclusion.

**The kernel does not own the list.** `BotDurableAuthorityHooks` gains
`providerReconciles?(providerId): boolean`. An absent hook means every provider
reconciles, which is exactly today's behaviour, so a host that never implements
it is unaffected. The Shell Package supplies the one this deployment uses: a
literal set naming the providers whose Packages register an
`LlmReconciliationCapability`.

**The partial answer survives the settlement.** A Turn that had streamed three
paragraphs before the restart keeps them. The mechanism already existed for a
stopped or superseded Turn — `interruptedOutcomeTextV1` reads the words back out
of `assistant/chunk` — and `ClientRunOutcomeV1`'s `failed` variant now carries
the same optional `text`. In the thread it reads as the Turn does when it is
stopped: what it said, then the line saying why it ends there. The words are a
fact about what the person watched arrive, not a claim that the Turn succeeded.

**The notice is written for the person.** "This Turn stopped partway — the
service restarted while the model was answering, and there is no way to find out
how that request ended. Try sending it again." It says the one thing they can
act on. It does not name a run id, a provider, or reconciliation.

## Considered options

- **Keep parking, and add a way for the deployment to bulk-resolve.** Rejected:
  it moves the dead end rather than removing it, and it leaves the Bot wedged in
  the window before somebody runs it.
- **Retry the request on recovery.** Rejected outright — this is the silent
  duplicate ADR 0024 forbids, and the reason the park exists at all.
- **Ask the provider at recovery time and park only if retrieval actually
  fails.** Rejected for now: it means mounting the pinned Composition inside, or
  around, the settling transaction, which is a much larger change for an answer
  that is already statically known. If a provider with real retrieval ever
  becomes the common case, this is the option to revisit, and the hook is the
  seam it would replace.
- **Treat an unretrievable outcome as `cancelled`.** Rejected: nobody cancelled
  it. `failed` with a plain reason is what happened.

## Consequences

- A restart mid-Turn now costs the person one re-send instead of a banner, a
  Resolve click, and a Bot that refuses every message until they find it.
- A provider Package that gains retrieval must name itself in the Shell's list
  or its Turns will settle as failed rather than parking. That is the safe
  direction to be wrong in, and it is the obligation this ADR carries.
- `reconciliation-required` does not go away. It is still the outcome for a run
  whose provider *does* reconcile, and for every unresolved **tool** effect,
  which this ADR does not touch: a tool occurrence is reconciled through the
  journal and the `ToolEffectReconciliation` path exactly as before.
- A run journaled before this change is settled by the same rule, because the
  rule reads the provider id the journal already carries. Runs sitting parked
  right now are not migrated; they keep their banner.
- `ClientRunOutcomeV1`'s `failed` variant gains an optional `text`, so an older
  client decoding a newer body rejects the extra key. Client and Worker ship
  together, so this is a rollback property rather than a steady state — the same
  shape ADR 0026 accepted for `runs` frames.
