# Jev primitives

Snapshot: 2026-09-19. Primary sources: [Primitives](https://docs.typesafe.ai/primitives),
[Choice](https://docs.typesafe.ai/primitives/choice),
[Noul](https://docs.typesafe.ai/primitives/noul),
[Score](https://docs.typesafe.ai/primitives/score), and
[Advanced structure](https://docs.typesafe.ai/primitives/advanced).

## Shared form

Every request supplies a non-empty object of named questions. The keys are
returned unchanged under `answers` but are not shown to Jev. Each question has a
`type`, `instructions`, and primitive-specific `criteria`.

`instructions`, state, and criterion descriptions use the SDK's `EntryType`:

```ts
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null;
```

Objects/arrays organize meaning. They do not ask Jev to return an arbitrary
object; output remains the fixed primitive response.

## Choice

Use Choice when exactly one option from a supplied closed set should win relative
to the others.

```ts
import { choice } from "@typesafe-ai/sdk";

const intent = choice(
  {
    question: "Which handler should receive `message.text`?",
    exclude: "Do not infer a purchase request from general product curiosity.",
  },
  {
    account_help: {
      include: "Login, profile, or subscription administration",
      exclude: "Payment disputes",
    },
    billing: {
      include: "Charges, invoices, refunds, or payment methods",
      exclude: "General pricing questions before purchase",
    },
    product_question: "Capabilities or how-to questions",
    no_match: "None of the other options fits",
  },
);
```

Request shape:

```ts
interface ChoiceQuestion<T extends Record<string, EntryType>> {
  type: "choice";
  instructions?: EntryType;
  criteria: T;
}
```

Response shape:

```ts
interface ChoiceResponse<T> {
  readonly type: "choice";
  readonly choice: keyof T & string;
  readonly probabilities: { readonly [K in keyof T]: number };
  readonly confidence: number;
}
```

The probabilities sum to 1 across supplied options; the chosen label has the
highest probability. Confidence summarizes how concentrated the distribution is.
It is not simply the winning probability and does not prove the option is correct.

Include a no-match/other option whenever the real input may fall outside the
listed choices. Choice is relative: it will still select the best supplied option
even if every option is a poor absolute fit. Add one Noul per candidate or a
separate presence question when “none is acceptable” is independently important.

Choice supports up to 255 options. For large hierarchies, walk the taxonomy one
level at a time and retain multiple high-probability branches when a greedy choice
would discard plausible paths.

## Noul

Use Noul for the probability that one specific yes/no condition holds. “Noul” is
the primitive name; the returned `noul` value is a number from 0 (no) to 1 (yes).

```ts
import { noul } from "@typesafe-ai/sdk";

const asksForRefund = noul(
  "Is the customer in `message.text` asking to receive money back?",
  {
    true: "An explicit or clearly implied request for a refund",
    false:
      "A billing question, complaint, or duplicate-charge report without a refund request",
  },
);
```

Request shape:

```ts
interface NoulQuestion {
  type: "noul";
  instructions?: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null;
}
```

Response shape:

```ts
interface NoulResponse {
  readonly type: "noul";
  readonly noul: number;
}
```

Noul has no separate confidence field. The probability itself expresses the
yes/no uncertainty: values near 0.5 mean similar probability for yes and no,
not medium intensity. If several labels may independently apply, use one Noul per
label. If exactly one label must win, use Choice.

Do not treat `noul(question)` and `1 - noul(negatedQuestion)` as an identity, or
copy a threshold from a Choice probability to a Noul. They are separate model
judgments.

## Score

Use Score for position along one ordered qualitative dimension. Criteria are an
ordered tuple or array with 2–10 levels, indexed from zero.

```ts
import { score } from "@typesafe-ai/sdk";

const urgency = score(
  "How time-sensitive is the action requested in `message.text`?",
  [
    "No time pressure stated or implied",
    "A normal near-term need; delay is inconvenient",
    "A deadline or active harm makes prompt action important",
    "Immediate action is needed to prevent serious ongoing harm",
  ] as const,
);
```

Request shape:

```ts
type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]];

interface ScoreQuestion<T extends ScoreCriteria> {
  type: "score";
  instructions?: EntryType;
  criteria: T;
}
```

Response shape:

```ts
interface ScoreResponse<T> {
  readonly type: "score";
  readonly score: number;
  readonly legend: Record<string, EntryType>;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}
```

`score` is the expected value over level indices and may be fractional. It is
useful for ordering or thresholding against a validated rubric. It is not a
precise measurement of a real numeric magnitude. `legend` maps index strings to
the supplied descriptions; `probabilities` maps those index strings to values
that sum to 1. Different distributions can have the same expected score, so keep
the distribution and confidence when ambiguity matters.

Write levels that are ordered, concrete, mutually understandable, and independently
meaningful. Keep one semantic dimension per Score. Split “quality” into dimensions
such as correctness, completeness, and clarity if each has independent product
value. Each level must stand alone; do not define it as “more than the previous
level,” because levels are evaluated from their own descriptions.

## Choosing the primitive

| Need                           | Primitive | Important consequence                                                  |
| ------------------------------ | --------- | ---------------------------------------------------------------------- |
| One winner from a closed set   | Choice    | Probabilities are relative across candidates.                          |
| Whether one condition holds    | Noul      | The `noul` value is the yes probability; there is no confidence field. |
| Degree along an ordered rubric | Score     | The result is an expected rubric index, not an exact numeric fact.     |

Common mistakes:

- yes/no Choice where an absolute Noul is intended;
- separate Nouls when exactly one category must win;
- Score levels that combine unrelated dimensions;
- omitting `no_match` from an incomplete Choice set;
- relying on the question ID as prompt text;
- asking Jev to invent an option or extract arbitrary prose;
- writing criteria that reverse or contradict the instruction.

## Structured instructions and criteria

Use JSON structure to make boundaries reviewable:

```ts
const questions = {
  safeToAutoReply: noul(
    {
      target: "The proposed reply in `draft.text`",
      decision: "Can this be sent without human review?",
      requirements: [
        "Directly answers the user's request",
        "Contains no unsupported factual claim",
        "Does not promise an external action that has not happened",
      ],
    },
    {
      true: {
        meaning: "All requirements hold",
        examples: ["Routine factual acknowledgment"],
      },
      false: { meaning: "Any requirement fails or evidence is missing" },
    },
  ),
};
```

Prefer repeated field names across Choice options or Score levels so distinctions
are easy to compare. Include examples only when they clarify a boundary; examples
are not a substitute for the rule.
