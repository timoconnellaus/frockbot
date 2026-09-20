# HTTP API

Snapshot: 2026-09-19. Primary source: [HTTP API reference](https://docs.typesafe.ai/api).

Use the official SDK unless a package boundary requires raw HTTP. The endpoint is:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

## Request

```ts
interface SystemOneRequest {
  state: string | JsonObject | JsonValue[];
  model: string;
  questions: Record<string, NoulQuestion | ChoiceQuestion | ScoreQuestion>;
}

interface NoulQuestion {
  type: "noul";
  instructions: string | JsonObject | JsonValue[];
  criteria?: { true?: EntryType; false?: EntryType };
}

interface ChoiceQuestion {
  type: "choice";
  instructions: EntryType;
  criteria: Record<string, EntryType>;
}

interface ScoreQuestion {
  type: "score";
  instructions: EntryType;
  criteria: EntryType[]; // 2–10, ordered from level 0
}
```

The HTTP documentation describes `state` as required string/object/array, `model`
as required, and `questions` as a required map. Each key is returned under the same
answer key and is not used during inference.

Example:

```json
{
  "state": {
    "ticket": "Help! My payouts have failed for three days."
  },
  "model": "jev-1.13.0",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle `ticket`?",
      "criteria": {
        "billing": "Payments, invoices, refunds",
        "technical": "Bugs, outages, integrations",
        "other": "No listed team is a good fit"
      }
    },
    "urgent": {
      "type": "noul",
      "instructions": "Does `ticket` require time-sensitive action?",
      "criteria": {
        "true": "Delay is causing active harm or missing a deadline",
        "false": "No time-sensitive consequence is stated"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer in `ticket`?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

## Response

```ts
interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
```

Choice probabilities span every supplied option and sum to 1. Score probabilities
span level indices (encoded as string keys) and sum to 1. Score is their
probability-weighted expected index. Confidence is in 0–1 for Choice/Score. Noul
returns only its 0–1 yes probability.

`model` reports the model used. When an alias was requested, log this resolved
field so later behavior changes can be tied to a version. `usage` reports input
and output token counts; current pricing charges input tokens, but usage should be
retained independently of the pricing snapshot.

## Model listing

```http
GET https://api.typesafe.ai/v1/models
Authorization: Bearer <API_KEY>
```

The raw endpoint returns a `models` array; the JavaScript SDK exposes
`await client.models.list()` returning model cards with `name`, `description`,
and `release_date`. The listing currently emphasizes aliases; versioned IDs remain
accepted even when omitted from the list.

## Errors and raw retry behavior

Documented statuses:

| Status | Meaning                        | Default handling                                         |
| ------ | ------------------------------ | -------------------------------------------------------- |
| 401    | Missing or invalid API key     | Fix configuration; do not retry.                         |
| 422    | Invalid request shape/question | Fix code/data; do not retry unchanged.                   |
| 429    | Rate limit exceeded            | Honor retry headers and back off.                        |
| 529    | Service overloaded             | Back off and retry within the owning operation's budget. |

The JavaScript SDK additionally classifies common 400/403/404/5xx responses and
retries 408, 429, and 500–599 by default. Raw HTTP callers should implement
bounded exponential backoff with jitter and honor `Retry-After`/service guidance.

Separate transport/service errors from model answers. Never substitute a default
Choice, Noul, or Score on failure unless the product explicitly defines and tests
that fallback as policy.
