# JEV / TypeSafe System One — implementation research

> Source snapshot: 19 September 2026. This note is a factual companion for a
> repository-local agent skill. It intentionally favors the TypeScript SDK used by this
> repository. All product claims come from TypeSafe's own documentation or its official
> SDK repositories; no behavior below is inferred from model-training knowledge.

## Executive summary

Jev is TypeSafe's first **System One** model: it evaluates one text or JSON-shaped
`state` against named, typed questions and returns constrained decisions plus
probabilities. It does not generate prose, code, or reasoning. Application code keeps
ownership of rules, arithmetic, composition, side effects, and fallback behavior. The
three question primitives are `Choice` (one label from a closed set), `Score` (a
probability-weighted position over ordered descriptive levels), and `Noul` (the
probability that a yes/no statement is true). Questions sharing a state should normally
be sent in one call: they are evaluated independently and in parallel, including useful
speculative questions whose answers code may ignore. ([Introduction](https://docs.typesafe.ai/introduction),
[System One](https://docs.typesafe.ai/concepts/system-one),
[Primitives](https://docs.typesafe.ai/primitives))

For this TypeScript/Bun repository, the first-party package is `@typesafe-ai/sdk`.
The current public SDK documented during this review is `0.6.0`, requires Node.js 20+
according to its package metadata, ships ESM, CommonJS, and TypeScript declarations, and
infers answer keys and Choice labels from the supplied question object. TypeSafe does not
explicitly document Bun compatibility, so that must be verified locally rather than
assumed. ([JavaScript SDK](https://docs.typesafe.ai/sdk/javascript),
[v0.6.0 package metadata](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/package.json),
[SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts))

Jev 1.13's most important boundaries are deliberate: keep calculations, counting,
date ordering, exact parsing/normalization, structural invariants, and generation in
code or another model; keep state focused; minimize indirection; do not assume
semantically related questions obey arithmetic identities; and treat adversarial state
as capable of influencing an answer. ([Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13))

## 1. Mental model and division of responsibility

A System One call answers fast, narrow judgments a knowledgeable person could make in
seconds from supplied context. A broad request such as “decide the best course of
action” should be decomposed into independent questions, with deterministic code
combining the answers. The output is type-safe in the sense that it stays inside the
answer space supplied by the caller; it is not a guarantee that the judgment is true.
TypeSafe describes its model probabilities as calibrated across groups of predictions,
not as a correctness guarantee for an individual result. ([System One](https://docs.typesafe.ai/concepts/system-one),
[How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer))

Keep these concerns in code:

- exact business rules, permissions, policies that can be expressed deterministically;
- arithmetic, counting, comparisons, sorting, date/time calculation, parsing, and
  normalization;
- side effects and their safety/idempotency controls;
- composition of several semantic signals, including weights and thresholds;
- choosing whether to act, confirm, ask for more information, escalate, or abstain.

Use Jev for bounded semantic judgments such as which known handler fits, whether a
condition is supported by text, how content falls on a described spectrum, which
pre-extracted span has a requested role, or whether retrieved evidence is relevant.
([How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[Pre-parsed extraction cookbook](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook))

## 2. Current model, price, limits, and data handling

The current model table reviewed on 19 September 2026 is:

| Item                       | Documented value                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Versioned model            | `jev-1.13.0`                                                                                                  |
| Stable alias / SDK default | `jev-latest` → `jev-1.13.0`                                                                                   |
| Preview alias              | `jev-preview` → `jev-1.13.0` at review time                                                                   |
| Price                      | $42 per billion input tokens / $0.042 per million input tokens                                                |
| Output price               | free                                                                                                          |
| Rate limit                 | 250,000 tokens/second and 1,200 requests/minute                                                               |
| Input                      | text only; string, JSON object, or array of text/JSON values                                                  |
| Context                    | 64k tokens across state plus all questions; separately, 32k tokens for state plus the single longest question |

TypeSafe warns that rate limits are dynamic and may change without notice. A request that
exceeds either advertised rate limit returns HTTP 429. The `GET /v1/models` endpoint
lists names available to the account; the docs say it currently lists aliases, while a
versioned ID remains accepted even if absent from that list. An alias can move on release,
so log the returned model and pin a version when thresholds have been tuned against it.
The models page says the response reports the versioned ID that actually answered, even
though several illustrative response examples display `jev-latest`; integration tests
should trust and persist the actual response value rather than the examples.
([Models](https://docs.typesafe.ai/models))

Jev's primary training language is English. Other languages, including CJK scripts, are
accepted but documented as lower accuracy and require workload-specific testing. Images,
audio, video, and binaries must be preprocessed into text or structured fields. The same
weights serve all accounts; customization is performed through state, instructions, and
criteria rather than customer fine-tuning or LoRA. TypeSafe says customer requests and
responses are not used for training; zero-data-retention is an enterprise option rather
than the documented default. ([Models](https://docs.typesafe.ai/models),
[Legal](https://docs.typesafe.ai/legal))

### Documented context-limit mismatch

The dedicated Models page gives the precise 64k aggregate / 32k state-plus-longest-question
limits above. The Primitives page says the shared state-and-questions budget is “around
32,000 tokens.” These statements are not identical. Until TypeSafe reconciles them, treat
the Models page as the detailed contract and design each state plus longest question to
fit under 32k; do not rely on the remaining aggregate headroom without tests.
([Models](https://docs.typesafe.ai/models),
[Primitives: ask multiple questions](https://docs.typesafe.ai/primitives#ask-multiple-questions-together))

## 3. State

`state` is the material every question evaluates. One request has one state and one or
more questions; all questions see the same state. A state can be a string, an object, an
array, or—according to the JavaScript SDK type—`null`. Use a string for one simple piece
of text and named object fields for conversations, records, policies, identities, or
other context whose relationships matter. State is text/JSON context, not a place to put
the requested judgment: keep the facts in `state` and the judgment in each question's
`instructions` and `criteria`. ([State](https://docs.typesafe.ai/concepts/state),
[JavaScript `EntryType`](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EntryType),
[SystemOneRequest](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequest))

Name the exact fields a question should inspect with backticked dot/index paths such as
`` `ticket.messages[0].text` ``. This reduces ambiguity when the state contains several
records or actors. Include source text, relevant policies, relationships, and current
facts, but prefilter unrelated detail because Jev 1.13 loses accuracy as distractor-heavy
state grows. ([Primitives: reference fields](https://docs.typesafe.ai/primitives#reference-specific-fields),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13#large-state-full-of-irrelevant-detail))

## 4. Questions and answers

Each question lives under an application-chosen ID in `questions`. That ID is used to key
the matching answer but is **not sent to the model**, so the complete meaning must appear
in `instructions`. Instructions and criterion descriptions accept a string, JSON object,
array, or `null`; start with short strings, then use structured objects/arrays for named
definitions, comparisons, exclusions, examples, schemas, or taxonomies. Structure has no
reserved semantic field names—the model sees the keys and values, so choose descriptive
labels. ([Primitives](https://docs.typesafe.ai/primitives),
[Advanced structure](https://docs.typesafe.ai/primitives/advanced),
[JavaScript `EntryType`](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EntryType))

### 4.1 Choice

Use `Choice` when exactly one outcome should be selected from a closed, unordered set.
`criteria` is a map of option label to string/object/array/`null` description. Both label
and description reach the model. Give the full meaningful option set, distinguish nearby
options contrastively, and add `other`/`none_of_the_above` when the set may not cover the
input. A Choice supports up to 255 options. Large hierarchies are better handled level by
level, potentially retaining several high-probability branches rather than greedily
committing to one. ([Choice](https://docs.typesafe.ai/primitives/choice),
[Hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification))

A Choice answer contains:

- `type: "choice"`;
- `choice`, the label with the highest probability;
- `probabilities`, every supplied label mapped to a probability, summing to 1;
- `confidence`, a 0–1 summary of how concentrated the distribution is.

The JavaScript helper `choice(instructions, criteria)` preserves literal criterion keys
in the inferred response type. ([Choice](https://docs.typesafe.ai/primitives/choice),
[`choice()`](https://docs.typesafe.ai/sdk/javascript/api/functions/choice),
[`ChoiceResponse`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse))

### 4.2 Score

Use `Score` for one ordered semantic dimension. `criteria` is an array of 2–10 level
descriptions, low to high; the array index is the numeric level. Every level must stand
alone because the model sees its description, not its number or neighbors. Describe
concrete situations rather than degrees such as “moderate,” do not write “worse than the
previous level,” and do not add levels that cannot be distinguished. If a rubric joins
several independent properties (“punctual and smart and experienced”), split it into
separate Scores and compose them in code. ([Score](https://docs.typesafe.ai/primitives/score))

A Score answer contains:

- `type: "score"`;
- `score`, the probability-weighted mean of level indexes, so it may be fractional;
- `probabilities`, each level index (JSON string keys) mapped to a probability summing to 1;
- `legend`, level indexes mapped back to their descriptions;
- `confidence`, concentration of the level distribution.

Different distributions can produce the same expected `score`; inspect probabilities and
confidence rather than treating the scalar as complete. A fractional score expresses
position in the rubric, not an exact measured quantity. Do not use interpolation between
levels to reconstruct precise numbers. The current JS helper is
`score(instructions, criteria)` and requires a tuple/array with at least two entries.
([Score](https://docs.typesafe.ai/primitives/score),
[`score()`](https://docs.typesafe.ai/sdk/javascript/api/functions/score),
[`ScoreResponse`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse),
[Jev jaggedness: math using Score](https://docs.typesafe.ai/model-jaggedness/jev-1.13#math-using-score))

### 4.3 Noul

Use `Noul` for one yes/no judgment. `instructions` may be a question or statement; phrase
it so a value near 1 has the intuitive “yes/true” meaning. Optional `criteria.true` and
`criteria.false` descriptions clarify a subtle boundary. A Noul answer contains only
`type: "noul"` and `noul`, the probability of yes from 0 to 1. It has no separate
confidence field: values near 0 or 1 favor one side, while a value near 0.5 means yes and
no have similar probability. It does **not** mean medium intensity; use Score for a
spectrum. The JS helper `noul(instructions?, criteria?)` defaults instructions to `null`.
([Noul](https://docs.typesafe.ai/primitives/noul),
[`noul()`](https://docs.typesafe.ai/sdk/javascript/api/functions/noul),
[`NoulResponse`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulResponse))

### 4.4 Question independence and batching

Questions in a request are independently evaluated against the same state and cannot see
one another's answers. Adding or removing one should not alter the others. Batch every
independent question over the same state, including branch-specific speculative questions,
then consume only the answers relevant to the selected branch. Make a second request only
when the first answer is genuinely needed to fetch evidence, construct new state, or choose
the next options. Extra questions still consume input tokens. ([Primitives](https://docs.typesafe.ai/primitives#ask-multiple-questions-together),
[Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out),
[Parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions))

## 5. Probability, confidence, thresholds, and action policy

Choice and Score return the full probability distribution and a derived `confidence`
statistic from 0 to 1. A sharp, single-peaked distribution is high confidence; a flat or
split distribution is low confidence. Noul's scalar already is the probability of yes,
so there is no separate confidence. Confidence is a convenient default summary, not a
universal measure; use the full distribution when runner-up mass or a custom uncertainty
measure matters. ([Confidence](https://docs.typesafe.ai/confidence))

Do not read confidence as probability that the answer is correct. It describes the
shape of Jev's answer. Low Choice confidence can mean no clear winner; low Score
confidence can mean overlapping levels, a multidimensional question, or missing evidence.
Several acceptable alternatives may also produce a spread even when the decision is
harmless. ([Confidence](https://docs.typesafe.ai/confidence),
[Score](https://docs.typesafe.ai/primitives/score#reading-a-score))

Action gates belong to the application. A common architecture uses high confidence for
automatic action, medium confidence for confirmation/review/more evidence, and low
confidence for abstention or escalation. Thresholds must vary with consequence—a
read-only navigation can tolerate less certainty than a destructive or money-moving
action—and must be selected from representative labeled data, not copied from cookbook
examples. Preserve the raw probability/confidence in logs or durable decision records so
threshold changes can be audited. ([Confidence](https://docs.typesafe.ai/confidence#three-paths-for-using-confidence-in-your-code),
[Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing),
[Self-consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook))

Do not assume structural identities across separate questions. In Jev 1.13, a Noul and
a yes/no Choice asking “the same” thing can produce materially different numbers, and
`P(statement)` need not equal `1 - P(negated statement)`. Choice probabilities are
relative competition among supplied options; separate Nouls are absolute yes/no judgments
and may all be low. Tune thresholds per primitive and exact wording. ([Jev 1.13:
structural invariants](https://docs.typesafe.ai/model-jaggedness/jev-1.13#common-sense-structural-invariants))

## 6. HTTP API

The evaluation endpoint is:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

The raw HTTP request requires `state`, `model`, and a nonempty map of `questions`. The
response contains `model`, a same-keyed `answers` map, and `usage.input_tokens` /
`usage.output_tokens`. Standard documented errors are 401 (missing/invalid key), 422
(validation failure with the offending field described), 429 (rate limit), and 529
(temporary overload). Direct HTTP callers should exponentially back off on 429 and 529;
the SDK retries these and other configured transient failures by default.
([HTTP API](https://docs.typesafe.ai/api))

Minimal raw request:

```json
{
  "state": { "message": "I was charged twice. Please fix this." },
  "model": "jev-1.13.0",
  "questions": {
    "refund_requested": {
      "type": "noul",
      "instructions": "Does `message` ask for a refund?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle `message`?",
      "criteria": {
        "billing": "Charges, invoices, and refunds",
        "technical": "Bugs and integration failures",
        "other": "None of the listed teams"
      }
    }
  }
}
```

## 7. JavaScript/TypeScript SDK

### Installation and basic use

Official installation is `npm install @typesafe-ai/sdk`; in this Bun workspace the
equivalent package-manager operation should be used only after normal dependency review.
The client reads `TYPESAFE_API_KEY`, defaults to `jev-latest`, and calls `systemOne`:
([JavaScript SDK](https://docs.typesafe.ai/sdk/javascript))

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const questions = {
  department: choice("Which team should handle `message`?", {
    billing: "Charges, invoices, and refunds",
    technical: "Bugs and integrations",
    other: "No listed team fits",
  }),
  asksForRefund: noul("Does `message` explicitly request a refund?"),
  frustration: score("How frustrated is the writer of `message`?", [
    "Calm and matter-of-fact",
    "Frustrated but civil",
    "Angry, abusive, or threatening to leave",
  ] as const),
} as const;

const client = new TypeSafeClient();
const result = await client.systemOne({
  state: { message: "I was charged twice. Fix this now." },
  questions,
  // model: "jev-1.13.0", // pin when thresholds depend on this version
});

result.answers.department.choice; // typed criterion key
result.answers.asksForRefund.noul;
result.answers.frustration.score;
```

The official package supports ESM and CommonJS. Its `SystemOneResult<Q>` maps every
question key to a primitive-specific `ResultFor<Q[K]>`, preserving Choice criterion keys
and fixed Score tuple indexes when literals are retained. ([SDK README](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/README.md),
[SDK types](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts),
[`SystemOneResult`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult))

### Client configuration

Explicit constructor values override environment variables, which override SDK defaults.
Empty/whitespace-only environment values are ignored. ([`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig),
[`TypeSafeClient`](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient))

| Setting                   | Environment              | Default / behavior                                              |
| ------------------------- | ------------------------ | --------------------------------------------------------------- |
| `apiKey`                  | `TYPESAFE_API_KEY`       | required                                                        |
| `baseURL`                 | `TYPESAFE_BASE_URL`      | `https://api.typesafe.ai`                                       |
| `defaultModel`            | `TYPESAFE_DEFAULT_MODEL` | `jev-latest`                                                    |
| `logLevel`                | `TYPESAFE_LOG_LEVEL`     | `warn`; values `debug`, `info`, `warn`, `error`, `off`          |
| `logger`                  | —                        | prefixed `console`, filtered by log level                       |
| `timeout`                 | —                        | 10,000 ms **per attempt**, no total retry budget                |
| `retry`                   | —                        | partial override of retry defaults                              |
| `defaultHeaders`          | —                        | merged, per-call headers win except protected transport headers |
| `fetch`                   | —                        | global `fetch`; injectable for tests/transport                  |
| `dangerouslyAllowBrowser` | —                        | `false`; browser execution otherwise throws                     |

`info` logging includes request summaries. `debug` adds headers and request/response
bodies; known credential headers are redacted but bodies are **not**, so debug logging can
leak user content or other state and must not be enabled casually in production. The API
key must stay server-side; `dangerouslyAllowBrowser: true` explicitly exposes it to page
users. ([`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig))

### Per-call control and retries

`systemOne(request, options)` accepts an `AbortSignal`, per-attempt `timeout`, partial
`retry` overrides, and additional headers. The SDK's default retry policy is:

| Setting                      | Default                                       |
| ---------------------------- | --------------------------------------------- |
| attempts                     | initial attempt + 2 retries                   |
| retryable status             | 408, 429, and 500–599                         |
| first exponential delay      | 500 ms                                        |
| maximum backoff              | 5,000 ms                                      |
| jitter                       | subtract a random fraction up to 25%          |
| server delay headers         | honor `Retry-After` and `retry-after-ms`      |
| maximum honored server delay | 60,000 ms; longer values fall back to backoff |
| connection errors            | retry                                         |
| timeout errors               | retry                                         |

There is no total elapsed-time budget across retries, so callers with an end-to-end
deadline should supply and own an `AbortSignal`. Retried requests include
`X-TypeSafe-Retry-Count`. ([`RequestOptions`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions),
[`RetryPolicy`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy),
[official client source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts))

### Errors, metadata, and raw responses

Construction can throw `TypeSafeError` for a missing key, invalid configuration,
unsupported/no-fetch runtime, or prohibited browser use. Calls can reject with typed
HTTP subclasses such as `AuthenticationError`, `BadRequestError`,
`PermissionDeniedError`, `NotFoundError`, `UnprocessableEntityError`,
`RateLimitError`, and `InternalServerError`; transport failures use
`APIConnectionError`, timeouts `APITimeoutError`, and caller cancellation
`APIUserAbortError`. An `APIError` exposes `status`, parsed/text `body`, `headers`, and
the `x-typesafe-request-id` as `requestId`. ([JavaScript API index](https://docs.typesafe.ai/sdk/javascript/api),
[`APIError`](https://docs.typesafe.ai/sdk/javascript/api/classes/APIError),
[`TypeSafeClient`](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient))

The returned `APIPromise<T>` can be awaited normally, transformed with `.map()`, exposed
as a raw `Response` with `.asResponse()`, or paired with parsed data and request metadata
using `.withResponse()`. Do not both parse and consume the same raw body; `asResponse()`
transfers body ownership to the caller. Capture request IDs when reporting service errors.
([`APIPromise`](https://docs.typesafe.ai/sdk/javascript/api/classes/APIPromise),
[`WithResponse`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/WithResponse))

### Client-side validation and an SDK breaking change

The 0.6.0 SDK rejects an empty question map; rejects a Score whose criteria are not an
array or contain fewer than two entries; and its helper rejects an array passed as Choice
criteria. Other schema validation can still be rejected by the service as HTTP 422. The
0.6.0 release changed Score criteria from a dictionary keyed by integers to an ordered
sequence, so examples or code using the older map form are stale. ([official question
builder/validation source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/questions.ts),
[JavaScript SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog))

## 8. Authoring guidance

1. Start from the application behavior and list only the semantic judgments code cannot
   compute exactly.
2. Ask one coherent dimension per question. A bounded action selection may be complex,
   but do not hide independent factors inside it.
3. Give each question only the state needed to answer it and point to named fields.
4. Make instructions literal and precise. Put boundary cases, exclusions, and contrastive
   examples in criteria.
5. For Choice, ensure candidate coverage and add a no-match outcome where appropriate.
6. For Score, describe distinct situations at every level; never rely on numeric labels
   alone or interpolate a real-world quantity from the expected score.
7. For Noul, phrase the positive direction clearly and add true/false criteria only when
   the boundary needs definition.
8. Batch independent and speculative questions; make another call only for a real data or
   option dependency.
9. Keep questions, weights, and threshold constants together so review focuses on the
   actual decision policy.
10. Version questions and pin the model when a behavioral threshold has been evaluated;
    log the actual model, token usage, answers/distributions, and request ID as allowed by
    the product's privacy rules.

These rules synthesize TypeSafe's official primitive, building, agent-skill, and
jaggedness guidance. ([Primitives](https://docs.typesafe.ai/primitives),
[Advanced structure](https://docs.typesafe.ai/primitives/advanced),
[How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[official TypeSafe agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13))

## 9. Established architecture patterns and cookbook map

The main documented patterns are:

- **Speculative fan-out:** ask every potentially useful independent question once, then
  branch in code. ([Pattern](https://docs.typesafe.ai/patterns/fan-out),
  [parallel-question benchmark](https://docs.typesafe.ai/cookbooks/parallel_questions))
- **Confidence-gated routing:** use the answer as one axis and consequence-sensitive
  confidence policy as another. ([Pattern](https://docs.typesafe.ai/patterns/confidence-routing))
- **Composite scoring:** split dimensions into Scores and combine normalized values with
  explicit weights, or use probabilities as features for classical ML. ([Pattern](https://docs.typesafe.ai/patterns/composite-scoring),
  [feature discovery cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery))
- **Intent routing/function calling:** Choice selects a known handler and closed-set
  questions fill arguments; code validates and invokes the ordinary typed function.
  ([Intent routing](https://docs.typesafe.ai/patterns/intent-routing),
  [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling))
- **Retrieve/select/verify:** ordinary code or retrieval generates candidates, Jev ranks
  or chooses them, and code copies/normalizes the original value. ([Reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe),
  [line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find),
  [pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook))
- **Cascade/escalation:** a cheap deterministic or generative stage proposes data; Jev
  verifies it; uncertain or failed cases go to a reasoning model or person. ([SDE
  cascade](https://docs.typesafe.ai/cookbooks/sde_cascade),
  [citation checking](https://docs.typesafe.ai/cookbooks/citation_check))
- **Hierarchical/beam classification:** ask one taxonomy level at a time and retain top
  branches using probabilities. ([Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification))

Official worked examples cover the following reusable shapes:

| Problem                   | Reusable design                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| self-consistency / review | repeat Nouls or Choices; preserve raw values and compare decision stability; thresholds remain application policy ([Noul](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook), [Choice](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)) |
| parallel briefing         | many independent questions over one long shared document in one call ([parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions))                                                                                                                 |
| reranking                 | retrieve a short list first, then ask one judgment per query–candidate pair ([reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe))                                                                                                                      |
| semantic find             | Choice ranks line IDs while a Noul asks whether the document contains an answer ([line search](https://docs.typesafe.ai/cookbooks/semantic_find))                                                                                                                  |
| structure recovery        | one request joins hard-wrapped lines; another classifies blocks, with speculative companion questions ([autoformat](https://docs.typesafe.ai/cookbooks/autoformat))                                                                                                |
| skill routing             | first rank a large catalog, then fetch and verify only top candidates; a separate absolute question can reject them all ([skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion))                                                                  |
| entity alignment          | a three-level Score directly represents “leave / review / merge,” while companion Nouls identify disagreements ([entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment))                                                                           |
| RAG safety                | score retrieved passages for usefulness, contradiction, and hidden instructions before sending them to an answering model ([RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages))                                              |
| citation validation       | use exact string matching to catch fabricated quotes, then Choice judges contextual support ([citation check](https://docs.typesafe.ai/cookbooks/citation_check))                                                                                                  |
| LLM guardrails            | independently judge inbound/outbound hazards and severity; code decides pass/review/block/route ([guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails))                                                                                                  |
| date extraction           | Choices extract bounded components and relative-date modes; code assembles, validates, and compares dates ([date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook))                                                                         |
| classification fallback   | use Choice confidence to return a specific label when clear and a broader parent or review path when uncertain ([classification with confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence))                                              |

Cookbook performance numbers are demonstrations on their datasets, not product guarantees
or production thresholds. Reproduce the relevant experiment on FrockBot's own data.

## 10. Known Jev 1.13 limitations and required mitigations

TypeSafe publishes these failure modes for `jev-1.13`; the source was last reviewed by
TypeSafe on 17 September 2026. ([Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13))

| Failure mode                                  | Required mitigation                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| literal reading, negation, implied conditions | write the exact condition; add boundary cases; split ambiguous interpretation                                                                                       |
| math and numeric precision                    | calculate and compare in code; convert numeric encodings to semantic names/buckets before judgment                                                                  |
| counting                                      | enumerate candidates in code, ask per-candidate questions when semantic filtering is needed, then count in code                                                     |
| date/time ordering and duration               | extract bounded components with Jev; assemble, validate, compare, and offset in code                                                                                |
| indirection / multiple reasoning hops         | point directly to relevant named state; reduce hops and double negatives                                                                                            |
| long irrelevant state / context rot           | retrieve/filter first; send only relevant fields or preclassify passages                                                                                            |
| adversarial content and prompt injection      | treat state as untrusted, write explicit criteria, add guard questions where useful, and test adversarial cases; Jev does not isolate state instructions by default |
| conflicting instructions and criteria         | make criteria an aligned extension of instructions; avoid reversed true/false semantics                                                                             |
| assumed probability identities                | ask each decision one way; do not transfer thresholds across primitive types or expect negations to sum to one                                                      |
| generation                                    | use regex/code to enumerate candidates or a generative model to propose them; use Jev only to select/verify bounded values                                          |

## 11. Testing and production-readiness checklist

TypeSafe recommends testing on the target domain and consequences rather than selecting
questions or thresholds from confidence alone. A practical test corpus should include
clear positives/negatives, ambiguous and missing-evidence cases, every Choice option and
Score boundary, no-match cases, irrelevant distractors, negations, adversarial text,
non-English samples where applicable, and high-consequence actions. Track the exact model,
question/rubric version, raw answers/probabilities, token usage, latency, expected outcome,
and resulting application behavior. Analyze missing evidence, model errors, code errors,
and service failures separately. ([Confidence](https://docs.typesafe.ai/confidence),
[Score](https://docs.typesafe.ai/primitives/score#writing-good-levels),
[official TypeSafe agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md),
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13))

Before production:

- pin `jev-1.13.0` if thresholds were tuned against it, or explicitly accept alias drift;
- keep `TYPESAFE_API_KEY` only in server-side secret configuration;
- never enable browser access in a shipped client;
- keep debug logging off where state bodies may contain user data;
- impose an end-to-end abort/deadline around the SDK's per-attempt timeout and retries;
- decide which transient errors are safe to retry within the surrounding operation's
  idempotency boundary;
- persist/emit request IDs for support without logging forbidden content;
- set action-specific fallback behavior for service errors and uncertain answers;
- budget and monitor **input** tokens, which are the charged unit;
- re-evaluate questions and thresholds before moving a pinned model or allowing an alias
  to advance.

SDK security/configuration facts come from the current JS reference; evaluation guidance
comes from the official confidence, models, and agent-skill docs. ([Client config](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig),
[Retries](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy),
[Models](https://docs.typesafe.ai/models),
[Agent skill](https://docs.typesafe.ai/agent-skill))

## 12. FrockBot-specific integration implications (design inference)

The following is an inference from the official JEV contract and this repository's stated
invariants, not a TypeSafe product claim:

- A JEV call spends money and should therefore be admitted, attributed, and retried within
  FrockBot's existing durable effect/idempotency boundary rather than called casually from
  client code.
- `TYPESAFE_API_KEY` belongs in the server-side deployment secret path and must never enter
  Bot memory, Workspace, durable logs, or a browser/native client.
- Wrap the SDK behind a narrow app/package interface so question definitions, model pin,
  timeout/retry policy, audit metadata, and tests are centralized. Do not scatter ad hoc
  `new TypeSafeClient()` calls or threshold constants through feature code.
- Store question-set/model versions with durable decisions when replay or audit matters.
  An at-most-once external action must not be reconstructed later from a new JEV answer.
- Treat all JEV output as a judgment, never authority: deterministic permission checks and
  irreversible-action approval stay in FrockBot code.
- Because FrockBot runs on Cloudflare/Bun-oriented TypeScript rather than a documented
  Node-only deployment, verify the SDK build and `fetch` behavior in the actual Worker and
  Bun test runtimes before adopting it. The SDK supports injected `fetch`, which provides
  a clean test seam.

The repository invariants are in [`AGENTS.md`](../../AGENTS.md); the relevant first-party
JEV SDK seams are [`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig),
[`RequestOptions`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions),
and [`SystemOneResult`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult).

## 13. Open or ambiguous areas

No live authenticated API call was made because this research task did not have or need a
TypeSafe API key. Consequently, the following must be checked during an implementation
spike rather than treated as established:

- Bun and Cloudflare Workers runtime compatibility (the package declares Node >=20 but
  offers injectable standards-based `fetch`);
- exact server-side validation constraints not stated in the public API docs, including
  label length, question count, payload byte size, and whether Choice has a server-enforced
  minimum option count;
- actual latency, calibration, failure rate, and rate-limit headroom for FrockBot data;
- how quickly analytics/billing usage appears and whether account-level spend controls or
  usage APIs exist—the reviewed docs expose per-response token usage but document no
  billing API;
- default data-retention period and region/subprocessor details, which require reading the
  linked legal agreements for the chosen account; only “not used for training” and
  enterprise ZDR are stated on the docs page;
- the 32k-versus-64k wording mismatch described above.

## Primary-source index

- [Complete TypeSafe documentation index](https://docs.typesafe.ai/llms.txt)
- [Introduction](https://docs.typesafe.ai/introduction)
- [Quick start](https://docs.typesafe.ai/introduction/quickstart)
- [System One](https://docs.typesafe.ai/concepts/system-one)
- [State](https://docs.typesafe.ai/concepts/state)
- [Primitives](https://docs.typesafe.ai/primitives), [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul), [advanced structure](https://docs.typesafe.ai/primitives/advanced)
- [Confidence](https://docs.typesafe.ai/confidence)
- [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- [Patterns](https://docs.typesafe.ai/patterns)
- [Models](https://docs.typesafe.ai/models)
- [HTTP API](https://docs.typesafe.ai/api)
- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) and [API reference](https://docs.typesafe.ai/sdk/javascript/api)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [Official TypeSafe agent skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md)
- [Official JavaScript SDK v0.6.0 source](https://github.com/typesafe-ai/typesafe-sdk-js/tree/v0.6.0)
- [Legal and data handling](https://docs.typesafe.ai/legal)
