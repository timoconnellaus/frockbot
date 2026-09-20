# Jev patterns and cookbook map

Snapshot: 2026-09-19. Primary sources: [Patterns](https://docs.typesafe.ai/patterns)
and the official [documentation index](https://docs.typesafe.ai/llms.txt).

Patterns are compositions, not universal thresholds. Reuse the shape and evaluate
questions, weights, and cutoffs on the feature's own data.

## Speculative fan-out

Ask all independent questions over shared state in one request, including
branch-specific ones. After the Choice selects a branch, code ignores irrelevant
answers. This avoids serial round trips and preserves independent judgments.

Use when a routing decision has predictable downstream questions. Do not use when
the first result is required to retrieve evidence or construct the candidate set.

Official pattern: [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out).
The [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions)
demonstrates one large batch versus sequential calls; treat its measured numbers
as an example, not a performance guarantee.

## Confidence-gated routing

The answer says what Jev prefers; confidence says how concentrated the Choice or
Score distribution is. Code maps the pair to automate, review, escalate, or use a
fallback. Make thresholds consequence-sensitive and validate confidence against
accuracy on labeled data.

Low confidence can be acceptable for harmless preference choices and important
for irreversible actions. Multiple acceptable Choice options may lower confidence
without making the top option unsafe. Noul has no confidence: gate on its yes
probability or distance from the uncertain middle as product policy requires.

Official references: [Confidence](https://docs.typesafe.ai/confidence) and
[confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing).

## Composite scoring

Ask separate Scores/Nouls for independently meaningful dimensions, normalize as
needed, and combine with explicit code-owned weights. This makes product priorities
reviewable and lets weights change without rerunning inference when evidence and
question meaning are unchanged.

Weighted sums fit compensating preferences. They do not fit veto policies such as
“any serious safety violation blocks”; represent those as separate gates.

Official pattern: [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring).

## Intent routing

Use Choice for a closed intent set and optional Score/Noul questions for complexity,
risk, urgency, or required authority. Route to deterministic code, a specialist
generative model, or a human. Include a no-match path and an uncertainty path.

Official pattern: [Intent routing](https://docs.typesafe.ai/patterns/intent-routing).

## Candidate generation then selection

Jev does not generate values. Find candidates using parsers, regex, retrieval, or a
generative model; send the source plus candidates; use Choice to select; then copy
and normalize the chosen source value in code. Include missing/no-match and verify
candidate coverage.

Cookbooks:

- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook):
  emails, phone numbers, and money candidates.
- [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook):
  closed-set components plus code-owned calendar math.
- [Structure recovery](https://docs.typesafe.ai/cookbooks/autoformat): classify
  text blocks and reassemble formatting in code.
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling): map
  requests to ordinary typed functions and closed-set arguments.

## Retrieve, rank, and judge evidence

Use deterministic/fast retrieval for a shortlist, then one comparable Score per
candidate or batched questions to re-rank. Keep stable candidate IDs in state and
question keys; the model selects/rates, code retains source content.

Cookbooks:

- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe): re-rank BM25
  candidates with semantic judgments.
- [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find): score
  line IDs and separately ask whether an answer exists.
- [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages):
  judge relevance, contradiction, hidden instructions, and safety before context
  reaches a generator.
- [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification):
  beam search over deep taxonomies using Choice probabilities.

## Verify and escalate

Ask narrow questions that compare a claim/field with supplied evidence. Route
uncertain or failing cases to a person or stronger reasoning model. Structural
validation and semantic verification are separate: valid JSON can still be wrong.

Cookbooks:

- [Double-checking citations](https://docs.typesafe.ai/cookbooks/citation_check):
  whether a source supports a claim.
- [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade): cheap extraction,
  Jev semantic verification, then reasoning-model escalation.
- [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails): batched
  hazard/severity judgments with code-owned pass/review/block policy.
- [Self-consistency: Nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)
  and [Choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook):
  preserve uncertain outcomes and compare repeat behavior.

## Relative choice plus absolute acceptance

When a shortlist always has a “best” item but none may be good enough, combine:

1. one Choice to rank/select among candidates;
2. one Noul per finalist (or one focused acceptance Noul) to decide whether the
   candidate should be used at all;
3. code-owned confidence/probability gates.

The [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion)
uses this shape to pick a skill and still reject all skills.

## Entity alignment and downstream ML

Use a Score whose ordered levels correspond directly to actions such as “leave
unlinked / review / merge,” optionally with independent evidence Nouls. For large
labeled workflows, Jev probabilities can become numeric features for a classical
model whose composition is trained and evaluated separately.

Cookbooks:

- [Entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment).
- [AutoResearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery).
- [Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence):
  fall back from a precise label to a broader taxonomy level when uncertain.

## Pattern selection checklist

- Is the answer space closed? Choice or candidate selection.
- May several labels hold independently? One Noul per label.
- Is there one ordered qualitative dimension? Score.
- Does the first answer only control code? Fan out in one request.
- Does the first answer determine new evidence/options? Use a second request.
- Can no candidate be acceptable? Add an absolute acceptance judgment.
- Can one severe signal dominate? Use a veto gate, not only a weighted mean.
- Is the consequence high? Add calibrated review/escalation and audit evidence.
