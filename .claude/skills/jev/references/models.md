# Models, limits, and data

Snapshot: 2026-09-19. Primary source: [Models](https://docs.typesafe.ai/models).
Commercial limits can change; verify live only when the task depends on current
pricing, quotas, or contractual terms.

## Jev 1.13

| Property                | Snapshot value                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| Versioned model ID      | `jev-1.13.0`                                                     |
| Stable alias            | `jev-latest` → `jev-1.13.0`                                      |
| Preview alias           | `jev-preview` → `jev-1.13.0` (no separate preview at snapshot)   |
| Price                   | $42 per billion input tokens / $0.042 per million input tokens   |
| Output price            | Free                                                             |
| Token rate limit        | 250,000 tokens/second                                            |
| Request rate limit      | 1,200 requests/minute                                            |
| Overall request context | 64k tokens for state plus all questions                          |
| Per-question context    | 32k tokens for state plus the longest single question            |
| Input modalities        | Text expressed as string/JSON object/array; no image/audio/video |

Rate limits are documented as dynamically adjusted and may change without notice.
A request exceeding token/sec or request/minute limits returns 429. SDKs retry
with backoff and honor retry headers by default.

Jev ingests shared state once and evaluates questions against it in parallel. The
64k budget covers state plus all questions combined; the 32k budget applies to
state plus the single longest question. The separate Primitives page says the
shared budget is “around 32,000 tokens.” Until TypeSafe reconciles the wording,
design state plus the longest question below 32k and do not rely on additional
aggregate headroom without testing. These are admission limits, not quality
targets: accuracy can degrade earlier when state is long and irrelevant.

Pre-process non-text media into text or structured fields before calling Jev.
Keep deterministic media processing outside the model.

## Aliases versus pins

`jev-latest` is the SDK default and moves to the newest stable release.
`jev-preview` moves to the newest release even if not official. An alias can
change answers without a code change. The response's `model` field reports the
resolved versioned ID, although illustrative docs sometimes show an alias in that
field; persist the actual response value.

Use an alias while exploring or when accepting automatic model evolution. Pin
`jev-1.13.0` when thresholds or labeled evaluations were tuned to that version,
and move deliberately after rerunning them. Always record the resolved response
model so historical decisions remain attributable.

## Customization

TypeSafe documents one shared model rather than per-customer fine-tuning or LoRA.
Adapt it through requests:

- put proprietary/current evidence in `state`;
- encode domain rules and boundaries in instructions/criteria;
- decompose broad judgments and combine them in code;
- use returned probabilities as features in a classical model if labeled data
  supports learned composition.

Do not assume account-specific weights or hidden memory.

## Languages

English is the primary training language and documented strongest language. Other
languages, including CJK scripts, are accepted but not equally reliable. Evaluate
the actual target-language corpus and use uncertainty-aware routing before relying
on a non-English workflow.

## Data handling

TypeSafe states that customer requests/responses are not used to train Jev. The
models page points to TypeSafe's legal documents for its Data Processing Agreement,
Privacy Policy, and enterprise zero-data-retention offering. Enterprise ZDR is not
the documented default. Verify the applicable agreement and retention terms before
sending sensitive FrockBot content, and minimize state regardless.

The model is text-only, but JSON state can still contain personal, confidential,
or regulated data. Apply FrockBot's existing data classification, retention, audit,
and secret rules before introducing the call.

## Listing available models

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();
for (const model of await client.models.list()) {
  console.log(model.name, model.release_date, model.description);
}
```

`GET /v1/models` lists names accepted for the account, with description and
release date. At the snapshot it lists aliases; versioned IDs are accepted even
when not shown. Model availability is an operational check, not a reason to let an
alias silently bypass a version pin chosen by product policy.
