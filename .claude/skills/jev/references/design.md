# Jev design model

Snapshot: 2026-09-19. Primary sources: [Introduction](https://docs.typesafe.ai/introduction),
[System One](https://docs.typesafe.ai/concepts/system-one),
[State](https://docs.typesafe.ai/concepts/state), and
[How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

## What Jev is

Jev is TypeSafe's first System One model. It accepts a JSON-compatible `state`
and a non-empty map of typed questions. Every question is evaluated independently
against the same state. The result is structured data for code to consume:

- Choice: selected label, probability per label, confidence.
- Score: probability-weighted score, probability per level, level legend,
  confidence.
- Noul: probability that the answer is yes.

System One is intended for quick, focused judgments rather than extended
reasoning or generation. Code remains the orchestrator. This differs from an
agent loop: Jev does not choose its next action, execute tools, or generate a
plan. It supplies programmable common sense inside an ordinary software
workflow.

## The design boundary

Use ordinary code for:

- exact rules, parsing, validation, arithmetic, counting, ordering, and date math;
- database lookups and deterministic retrieval;
- permissions, policy enforcement, budget checks, and side effects;
- combining several judgments into the product's final decision.

Use Jev when the application must interpret natural language or make a bounded
semantic judgment whose answer can be represented as a closed choice, a yes
probability, or a qualitative ordered score.

Good fits include intent routing, relevance/risk/quality judgments, candidate
selection, evidence verification, semantic ranking, and extracting a value by
selecting from candidates found by code. Poor fits include prose generation,
multi-step reasoning, exact computation, open-ended extraction, and autonomous
control flow.

## Design from behavior backward

Start with what the application will do: show, select, rank, block, route,
review, or escalate. Work backward to the minimum semantic judgments needed for
that behavior. Keep each judgment independently inspectable so a policy change
can alter code weights or thresholds without rewriting a broad prompt.

Example: do not ask “Is this support ticket urgent and where should it go?” Ask
separate questions for department, time sensitivity, customer frustration, and
whether a refund is requested. Compose the route in code.

Atomic means one coherent judgment, not necessarily one sentence. A bounded
action selection can be atomic. A question that mixes independent properties or
asks for a chain of reasoning is not.

## State

`state` may be a string, JSON object, JSON array, or `null` at the SDK type
level. Prefer a string for one simple text and a named JSON object for multiple
pieces of evidence. JSON structure preserves roles and relationships that
flattened prose can blur.

Useful state contains:

- the source text or records to judge;
- stable identities and relationships;
- current facts and relevant policy text;
- candidate values when Jev must select rather than generate.

Exclude unrelated history and decorative metadata. Jev ingests state once and
evaluates all questions against it, so a focused shared state is both economical
and easier to debug. Large irrelevant state degrades accuracy.

Question IDs are only response keys and are not used in inference. Put the full
meaning in `instructions` and `criteria`; never rely on an expressive question
ID to communicate meaning. To disambiguate nested state, name an exact path in
backticks, for example `conversation.messages[2].content`.

## Question structure

Instructions and criteria accept strings, JSON objects, or arrays. Use a simple
string when it is unambiguous. Use structure when a reviewer benefits from named
parts such as:

- `definition`, `include`, `exclude`, and `examples`;
- positive and negative boundary cases;
- the exact field/path being judged;
- comparable fields repeated across Choice options or Score levels.

Structure is semantic organization, not an extra output schema. Jev still
returns the primitive's fixed response shape.

Choice criteria should be contrastive: say what belongs in each option and what
belongs in a neighboring option instead. Score levels should describe concrete,
ordered situations and make sense independently. Noul criteria may describe the
meaning of true and false, aligned with the instruction.

## Parallel questions and request boundaries

Put independent questions over the same state into one request. They are
evaluated independently and in parallel; one answer is not hidden context for
another. Speculative fan-out is valid: ask branch-specific questions up front
and ignore answers for branches the code does not take.

Use another request when the first answer is required to:

- retrieve new evidence;
- determine the next set of candidates;
- construct meaningfully different state;
- choose a dependent question that cannot be stated speculatively.

Extra questions still consume input tokens. Measure actual cost and latency;
parallel does not mean free.

## Composition and uncertainty

Keep raw answers available and apply product policy in code. Common compositions:

- hard route: selected Choice label;
- confidence gate: automate above a validated threshold, otherwise review;
- absolute gate: compare a Noul probability to a calibrated threshold;
- composite score: weighted combination of independent signals;
- veto: any high-probability serious condition forces review/block;
- two-stage selection: relative Choice to pick the best candidate plus Nouls to
  decide whether any candidate is acceptable.

Confidence is about concentration of a Choice/Score distribution, not permission
to act and not a guarantee of correctness. A harmless preference may not need a
gate; a high-consequence action should generally have stricter evidence and a
review path. Thresholds are product decisions validated against labeled examples.

## Evaluation loop

Maintain representative labeled cases, including easy, ambiguous, boundary,
missing-evidence, adversarial, and out-of-domain inputs. For each change to state,
instructions, criteria, model ID, or threshold:

1. capture the exact request and resolved model version;
2. compare raw probabilities/confidence and final application route;
3. separate missing evidence, question-design error, model error, code error, and
   service failure;
4. measure false positives/negatives against the consequence of each route;
5. keep threshold and question constants reviewable in one place.

Typed output guarantees the interface, not the truth of the judgment.
