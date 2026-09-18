# ADR 0032: Model providers as Plugins

Status: accepted, 2026-09-18. Numbered after ADR 0031.

## Context

The platform ships Frock AI built in and lets a User connect other providers
from a compiled catalog: each catalog provider is a Package with a connection
type, a model list and an adapter compiled into the deployment. The adapter is
the part that cannot be replaced — it knows a provider's wire — and it is the
reason a new provider needs a release.

ADR 0026 already provides the machinery for code that arrives after the build:
one Dynamic Worker per User, content-addressed artifacts, a descriptor, a
mount, a health report, a versioned hook contract, and loopback capabilities
that reach the kernel only through calls the Bot Durable Object resolves. The
first slice of turning providers into Plugins asks a narrower question: can a
Plugin serve a Bot's _model_, with the credential staying the host's and the
durable Turn path unchanged?

Two facts about the platform shaped the answer. A Plugin worker shares one
realm with every other Plugin its User installed, so `pluginId` is a name, not
an authentication. And a model call spends money, so it is the effect the
constitution is most careful about: intent recorded before the call,
at-most-once by key, explicit failure, no silent retry.

## Decision

### A provider is a contribution with a protocol

A Plugin may declare `modelProviders: [{ id, protocolVersion }]`. The kernel
hands it a normalized model request — the same shape a Package's adapter
receives, minus the Connection binding — and it answers with normalized stream
events: `text-delta`, `tool-call`, `usage`, `provider-state`,
`response-format-note`, `structured-output-failure`, `finish`, plus two
protocol-only events: a `provider-failure` that states a classification in the
Plugin's words, and a `progress` heartbeat that only resets the host's silence
allowance — the kernel never sees it. The protocol is versioned; the
declaration is a claim, never a grant. The host bounds what it will hold of an
answer — eight mebibytes of lines, a hundred thousand events, 128 tool calls
held behind a terminal — because a Plugin worker is one realm shared with
every other Plugin its User installed, and the host is the one buffering. The
ceiling is deliberately far below what the isolate could allocate, and far
above the largest answer the deployment's own output bound permits; a stream
that overruns any of it is refused and cancelled rather than buffered.

Selecting the provider is what runs the contribution. The Bot's plugin switch
still governs its tools and hooks — a provider Plugin with tools is off until
switched on — but a Bot whose model names the provider is served by it either
way, because choosing the model _is_ the decision to run that code.

### The deployment decides what a contribution may reach

Whether a provider may be served through a Plugin at all is compiled into the
deployment's provider catalog (`providers/catalog/definition.ts`), one entry
per provider: the Plugin id that serves it, the Package its Connections belong
to, the inference route, the endpoint, and the auth scheme. The descriptor
cannot widen any of it.

- A member declaring the provider whose id or artifact content hash is not the
  catalog's fails to mount, and so does a second claimant. A Plugin a Bot
  wrote cannot take over a provider by claiming it.
- The transport sends to the Connection's own `api-base-url` when the User set
  one, and to the catalog's endpoint otherwise, along the one route — so a
  Plugin cannot reach a provider's billing, file or fine-tuning routes, another
  origin, a query, or a redirect.
- The host composes the request's shape: POST, `content-type`, `accept`, the
  bearer credential, and the durable request id as `Idempotency-Key`. The
  Plugin composes the body, and the host checks it: the admitted model, the
  streaming inference operation and no other, and an output ask that the body
  states and that stays inside the bound. That bound is the smaller of the
  deployment's ceiling for the provider and the selected model's own catalog
  limit, carried on the Connection: a body that names no output field is
  refused rather than left to the provider's default, and another dialect's
  spelling of one is refused rather than guessed at.
- The endpoint is https, carries no credentials, no query and no fragment, and
  the route is a plain path under it.

### One dispatch per durable effect

The kernel's model effect is the request id. The loop writes `model/request`
before every dispatch; the transport sends upstream only for the **first**
journaled `model/request` for that id, and only when its provider, model and
Connection binding match the dispatch. A second occurrence — a retry after an
outcome the kernel could not confirm, or a re-dispatch after an eviction — is
refused before the fetch. How that refusal is accounted for is the log's to
say, and the log is read twice: once when the attempt is **admitted**, before
the Plugin is called, and again at the refusal. The second reading matters
because an attempt can fail without ever reaching the transport — a worker
that throws, a clock that runs out — and a failure that early must not report
a definitive no-effect result for an effect whose earlier call may have been
accepted and billed.

An effect is **accounted for** when its own `model/usage` is on the log, or
when the kernel journaled a `model/retry` after the earlier dispatch: the loop
writes a retry only after a failure it classified, and a classified failure is
by contract one the host watched the provider refuse before it did any work —
or one nothing was sent for — so that effect is known to have cost nothing and
the refusal is definitive, with no estimate written. Only an earlier dispatch
that ended in silence is uncertain: it may have reached the provider and
billed, so the attempt is settled with the estimate rather than reported as a
call that never happened.

The same reading answers a refusal made before any dispatch is opened at all:
a request the mount can no longer serve — the credential was rotated while the
run was interrupted, so the journaled binding is not the one in force — is
still a result for the _effect_, not for this attempt, and it keeps the earlier
call's possible cost instead of reporting a definitive no-effect result.

The consequence is deliberate and conservative for this slice: **one request
id is one upstream call**, even where the first attempt may have failed before
reaching the provider (a refusal, a crash between the journal write and the
fetch). A retry after a definitive no-effect failure is not attempted; the Turn
settles and the person's next message is a new id and a clean attempt.

### The summariser is a model effect too

A conversation's compaction calls the model outside any Turn: the summary is
composed after `turn/end`, and the shell detaches it so the person's next
message is not held behind it. That call is still billed spend, so it is not
exempted from the transport — it is admitted by the durable intent the
compaction already writes (`conversation/compaction-intent`, keyed by the
effect id it is dispatched under). The transport accepts either the loop's
`model/request` for an ordinary call, or an unresolved intent with the same
effect id, provider, model and source binding while the compaction that wrote
it is running. The session the check reads is the host's own reference,
captured when the composition mounted — never one the Plugin named — and the
composition is retained past the Turn for exactly this call. One summariser
effect is one upstream call, and its lease is released where the call ends.

The ticket itself is per attempt and one-shot: minted when the attempt opens,
spent by the call it is spent on, and it cannot be presented again. The
dispatch owns the upstream call's abort, so an attempt that ends — its own
error, a Stop, the Turn deadline, the stream being abandoned — aborts a call
still in flight.

### Uncertainty is not a provider failure

A failure the Plugin states is believed about _why_ only when the host has no
better answer: a Plugin that made the call does not get to declare it free.

The host's own observations are what decide. A **refusal** is a call the host
watched the provider reject _before it did any work_ — a 4xx it read itself,
a redirect, or a decision it made before sending at all (no credential, no
ticket, a body or destination it will not send, a clock that ran out). That is
the only kind that may be treated as a call that did not bill, because it is
the only kind the provider stated about a call it had not taken.

A 5xx is not one of those. The request reached the provider and the provider
failed, which may mean it accepted and processed the call first; whether it
billed is exactly what is unknown. It is reported the same way as a body that
died, a 200 with no body, or a call that never answered: as uncertainty. A
retry the kernel plans for a rate limit never becomes a second call either —
the durable guard refuses it before the fetch — so one request id stays one
upstream call however the failure is classed. Everything else that happens after the request left is
**uncertain**: the provider answered and the answer died, the answer arrived
with no body, the connection was lost, or the clock ran out waiting. Those are
reported as `ModelOutcomeUncertainErrorV1` — deliberately not a
`ModelProviderFailureError`, which the kernel and Billing treat as a definitive
no-effect result. The kernel records the estimate and settles the Turn rather
than dispatching again, because whether the provider billed is exactly what is
unknown.

The clock is the one failure that is read both ways, and it is read by what the
host dispatched rather than by what the clock says. A deadline that arrives
while the answer was still being waited on is uncertainty, because the request
left and may have been accepted. A worker that hung before it ever reached the
transport — or before the transport issued anything — dispatched nothing, so
the deadline's own sentence is a definitive failure and no estimate is written
for a call nobody made.

### Credentials never cross into the Plugin

The Plugin sees a ticket. The host resolves the Connection, leases the
credential, opens it in the Durable Object, and attaches it to the one call.
A revoked Connection refuses before anything is sent; an expired sign-in is not
a credential; an upstream error body is never forwarded to the Plugin. Every
attempt's lease is settled where the loop settles the outcome.

### Installation

A provider Plugin ships in the deployment catalog with the seed state
`installable`: in the catalog, seeded on no account. Installing the Package it
belongs to installs the artifact into that account's Composition, with
`installed` provenance and the artifact's content hash; uninstalling removes
it. The account's own command does both — `user/install-package`, or the
Models surface's `user/choose-model-provider`, which is what "Connect
provider" sends — and either leaves the Plugin in place before the model that
needs it can be chosen. Reconciliation runs on the composition read a Bot
makes before admitting a Turn, so a lost race or a transient failure is
repaired, and a deployment that updates the artifact reaches the next Turn.

An installed provider Plugin is listed on the account's Plugins surface beside
the seeded ones, described as the Plugin it is rather than as the compiled
Package's capability, and a row there can uninstall the Package — which takes
the Plugin out of the Composition and returns a Bot whose model went with it to
the platform default. Installing one is still the Models surface's business:
until there is a marketplace, a provider an account does not have is not
listed as something to add.

### The trust choice, stated plainly

A Plugin worker is one realm per User. A model provider Plugin's transport
call is admitted because the _dispatch_ is the host's — minted for this Turn,
this effect, this Connection — and not because anything about the caller is
authenticated. Within that realm, another Plugin could in principle call
`ctx.modelTransport` with a ticket it obtained; the ticket's scope, spend-once
rule and abort are what bound the damage, and the credential is never
disclosed either way. This is the same trust boundary ADR 0026 already states
for every other grant; it is not narrowed here, and the first slice does not
pretend `pluginId` is a security boundary.

The `ai` grant does not reach a plugin-served provider: its call is made
outside the loop, under a request id the Plugin chose, so it has no durable
`model/request` for the transport to bind to. A Plugin calling
`ctx.model.invoke` on such a Bot is told so in as many words.

## Consequences

- DeepSeek is served only through its Plugin: no compiled adapter registers
  `LlmProvider` for it, and a Bot whose model names it and whose account holds
  no Plugin serving it fails before anything is sent, with a sentence naming
  the missing Plugin.
- Everything else in the catalog keeps its compiled adapter. Moving one to a
  Plugin is a deliberate change to `PLUGIN_SERVED_PROVIDERS_V1` plus the
  artifact that serves it.
- A provider Plugin may not be served by a Package: the model path, the
  connection lifecycle and the model catalog are still compiled per provider,
  and this slice does not claim otherwise.
- The first slice's retry trade-off (one upstream call per request id) is
  explicit above; lifting it means teaching the durable log to record a
  definitive no-effect failure, not weakening the transport.
- Seeded artifacts are resolved from the deployment's current bytes (the
  compiled catalog, then R2), and seeded Plugins have no publisher of their
  own. A Turn pinned to a generation whose provider artifact a deploy has
  since replaced therefore fails the transport's content-hash check rather
  than running old code — correct about trust, and for the moment a deploy
  can interrupt a conversation whose next Turn pins the previous artifact.
  Serving old hashes would mean retaining every artifact version a
  generation might pin; that is deliberately out of this slice.

## Order

One slice, merged when green:

1. The protocol, the descriptor contribution, the worker entrypoint and the
   adapter.
2. The provider catalog entry, the trusted binding and the transport.
3. The DeepSeek artifact, the `installable` seed state and the install
   reconciliation.
4. Tests at every seam, and the documentation above.
