# Jev 1.13 jaggedness and failure diagnosis

Snapshot: 2026-09-19. Primary source:
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
officially last reviewed 2026-09-17.

Read this before production use and whenever an answer looks inexplicable. These
limitations apply to Jev 1.13; do not automatically project them onto later models.

## Known edges

| Failure mode                       | What goes wrong                                                                                 | Design response                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Literal reading                    | Jev answers the words written rather than unstated intent; scoping and negation matter.         | State the exact condition. Put boundary cases in criteria. Split unavoidable interpretation into direct questions. |
| Math and numbers                   | Arithmetic, counting, numeric proximity, and exact magnitudes are unreliable.                   | Compute/convert/count in code; ask only the semantic judgment.                                                     |
| Date/time comparison               | Dates are read as text, not reliably ordered quantities.                                        | Use closed Choices to extract components; assemble, compare, and calculate in code.                                |
| Indirection                        | Double negatives and multi-hop properties cost accuracy.                                        | Write directly and point to the relevant state path.                                                               |
| Irrelevant large state             | Distractors and context rot reduce accuracy and debuggability.                                  | Retrieve/filter first; send only relevant fields.                                                                  |
| Adversarial content                | State is not inherently treated as hostile; injected or self-advocating text can steer answers. | Use precise criteria, isolate evidence, test attacks, and retain code-owned policy.                                |
| Contradictory instruction/criteria | Reversed or misaligned definitions confuse the decision boundary.                               | Make criteria an aligned extension of the instruction.                                                             |
| Assumed structural invariants      | Semantically related separate questions need not obey complements/equalities.                   | Ask each decision one way, validate separately, enforce identities in code.                                        |
| Generation                         | Jev is not trained to generate prose or arbitrary values.                                       | Use a generative model, or enumerate candidates and select with Choice.                                            |

## Numbers and counting

Do not ask how many characters/items occur, perform arithmetic, compare numeric
encodings, or reconstruct a real magnitude by interpolating a Score. If the unit
can be found by a parser/regex, find and count it in code. If membership is
semantic, iterate candidates, ask a Noul per candidate in one request, and count
thresholded results in code.

Convert low-level numeric representations into names or computed features before
asking the semantic question. For example, convert hex colors to a named color or
distance in code, then ask whether the resulting color reads as a warning.

A Score is an expected position on a qualitative rubric. It can support a
validated threshold or ranking, but it does not recover an exact underlying
number between levels.

## Dates

Separate extraction from computation. Enumerate bounded candidates for month,
day, year, timezone, or relative expression; include `not_stated`; then construct
and validate a date with code. Code owns ordering, duration, offset, weekdays,
quarters, and business windows.

## Structural non-identities

Do not assume:

- a yes/no Choice's `probabilities.yes` equals a Noul asked with similar wording;
- `P(x) + P(not_x) === 1` when `x` and `not_x` are separate questions;
- confidence from one primitive is comparable to another primitive's probability;
- a threshold tuned on one wording transfers to its paraphrase or negation.

Choice is a relative competition among options. Independent Nouls ask absolute
questions and may all be low or several may be high. A useful two-stage design is
Choice to nominate the best candidate and Noul(s) to decide whether the candidate
is acceptable at all.

## Adversarial state

Treat user-provided documents, retrieved passages, tool outputs, and conversation
text as data that may contain instructions aimed at the model. Jev 1.13 does not
provide a security boundary between instructions and state. Precise question
criteria can reduce confusion but cannot replace authorization or policy in code.

For hostile-input features:

- isolate the exact excerpt/fields needed;
- ask direct questions about content rather than obeying content;
- include adversarial and self-referential examples in the evaluation set;
- use separate guardrail questions when helpful, but enforce the final policy in
  trusted code;
- route uncertain/high-consequence cases to a person or stronger verifier.

## Diagnosis checklist

For a bad result, inspect the exact:

1. resolved model version;
2. state, including omitted evidence and irrelevant distractors;
3. instruction and every criterion;
4. candidate coverage/no-match behavior;
5. primitive choice;
6. raw probabilities, confidence, and final code composition;
7. threshold provenance and labeled examples;
8. service/retry path versus a genuine model answer.

Classify the failure before changing the prompt: missing evidence, ambiguous
question, contradictory rubric, model error, code error, stale threshold, or
transport failure. Fix the smallest responsible layer.
