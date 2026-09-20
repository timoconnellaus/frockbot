# FrockBot integration guidance

This reference combines the Jev snapshot with the repository's documented
architecture and invariants. It does not choose a product seam automatically;
inspect the feature's owner before adding code.

## Placement

Jev is a narrow semantic evaluator, not a replacement for FrockBot's conversational
model provider. Prefer a small interface owned by the app feature that needs the
judgment. Keep request construction and threshold policy near that domain rather
than introducing a generic “AI service” container.

Before implementing, inspect:

- the owning workspace/package and its existing external-client conventions;
- `core/agent-loop` and `app/billing` if the call occurs inside a Turn or spends
  product-accounted model budget;
- `providers/` only if the requested work is genuinely a conversational model
  provider (ordinary Jev judgments usually are not);
- `app/isolates` and plugin grants if untrusted Plugin code can initiate the call;
- deployment configuration and Worker bindings for server-side secrets.

Avoid placing Jev in browser/native clients. The API key must remain server-side,
and the cloud remains authoritative.

## Durable effects and billing

A Jev call spends money. Under FrockBot's invariants, intent for a consequential
model call must be durably admitted before dispatch, with a stable idempotency/effect
identity across retries. Do not bolt an SDK call directly into a path whose replay
could create a second charge or a different recorded outcome.

The TypeSafe JavaScript SDK retries connection errors, timeouts, 408, 429, and 5xx
responses by default. Decide which layer owns retrying:

- If FrockBot's durable model/effect machinery owns attempts, configure the SDK so
  it does not create an opaque second retry loop, or account for every attempt.
- If a narrow non-durable diagnostic/evaluation tool owns the call, bounded SDK
  retries may be sufficient, but they still require a cancellation/time budget.

Do not infer from a timeout that TypeSafe did not receive or process the request.
The public Jev docs do not document an application idempotency header. Preserve the
repository's effect record and surface an explicit ambiguous outcome rather than
inventing exactly-once behavior.

## Secrets and configuration

- Provision `TYPESAFE_API_KEY` through the existing deployment/Worker secret path.
- Never commit keys, put them in Bot memory/workspace, include them in Plugin
  settings, or expose them to clients.
- Do not set `dangerouslyAllowBrowser`.
- Keep base URL/model/log-level overrides in the narrow deployment configuration
  that owns them; the product must still work with zero user configuration unless
  the feature explicitly introduces an optional account connection.
- Debug SDK logging includes bodies. Treat it as sensitive and keep it off in
  production unless the data policy explicitly permits it.

## Model and policy constants

Keep these together in one reviewable module for each workflow:

- model ID or alias;
- question instructions and criteria;
- Choice labels and Score levels;
- probability/confidence thresholds;
- composition weights/veto rules;
- fallback/review behavior.

If thresholds are calibrated, pin `jev-1.13.0`; an alias may change behavior
without a code change. Record `response.model`, token usage, feature/workflow name,
and the final code route in the appropriate audit/telemetry surface. Store raw
state/answers only to the extent allowed by the feature's privacy and retention
rules.

## Suggested boundary

Prefer an interface shaped by the application decision:

```ts
interface TicketJudgment {
  category: "billing" | "technical" | "other";
  categoryConfidence: number;
  refundProbability: number;
  urgencyScore: number;
  model: string;
  inputTokens: number;
}

interface TicketJudge {
  evaluate(
    input: TicketEvidence,
    signal?: AbortSignal,
  ): Promise<TicketJudgment>;
}
```

The adapter may use `TypeSafeClient`; application code consumes domain meaning.
Tests can supply a fake `TicketJudge` without reproducing SDK internals. Keep raw
probabilities when downstream policy may change without another paid inference.

## Tests

At minimum cover:

- the exact request built from domain state, with irrelevant/sensitive fields
  intentionally absent;
- type inference and mapping from every primitive response;
- threshold boundaries and uncertain review routes;
- no-match/missing-evidence behavior;
- cancellation, timeout, 422, authentication, rate-limit, overload, and malformed
  response behavior as relevant to the seam;
- retry ownership and stable durable effect identity;
- alias/version logging and usage accounting;
- adversarial content in state for user/retrieval-controlled inputs.

Use injected `fetch` or a feature-owned interface for unit tests. Live evaluation
is separate: use a bounded labeled dataset and an explicitly available API key.

## Validation and release

A change that adds a runtime Jev call touches an integration seam and usually the
runtime. Run the repository's full validation required by `AGENTS.md`, including
browser validation when the client behavior changes. A durable-record shape change
also requires the scoped cleanup mandated by the repository. Do not add a legacy
decoder or migration solely for pre-user compatibility.

The skill itself is documentation-only. Changes to questions used as runtime
constants are code changes because they alter behavior; validate them like code,
not like ordinary prose.
