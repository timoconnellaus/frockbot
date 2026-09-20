---
name: jev
description: Build, review, test, or design FrockBot features with TypeSafe AI's Jev System One model. Use when work mentions Jev, TypeSafe AI, System One, typed semantic judgments, Choice/Noul/Score questions, confidence-gated routing, or replacing prompt-and-parse logic with structured decisions.
---

# Build with Jev

Jev is a decision model, not a text generator or autonomous agent. It evaluates
one shared `state` against named, typed questions and returns typed values,
probability distributions, and (for Choice and Score) confidence. Keep workflow,
arithmetic, authorization, policy, and side effects in code; use Jev only for
bounded semantic judgment.

This skill is a self-contained snapshot of the official TypeSafe documentation,
verified 2026-09-19 against Jev 1.13 and JavaScript SDK 0.6.0. Use the bundled
references for ordinary work rather than researching the product again. Consult
live sources only when the User asks for an update, the installed SDK is newer
than this snapshot, runtime behavior contradicts the references, or a changeable
commercial/security fact must be current.

## Route the task

Read only the references the task needs:

- For whether Jev fits and how to decompose a workflow, read
  [references/design.md](references/design.md).
- For Choice, Noul, Score, structured criteria, responses, and question-writing,
  read [references/primitives.md](references/primitives.md).
- For this TypeScript/Bun/Cloudflare repository, installation, client options,
  errors, retries, and test doubles, read
  [references/typescript-sdk.md](references/typescript-sdk.md).
- For direct HTTP integration, request/response schemas, and status codes, read
  [references/http-api.md](references/http-api.md).
- For model IDs, aliases, limits, pricing snapshot, languages, and data handling,
  read [references/models.md](references/models.md).
- Before production use or when diagnosing bad decisions, read
  [references/jaggedness.md](references/jaggedness.md).
- For fan-out, routing, ranking, extraction, verification, and other reusable
  compositions, read [references/patterns.md](references/patterns.md).
- For repository-specific seams, durability, secrets, observability, and release
  consequences, read [references/frockbot.md](references/frockbot.md).
- For the complete source-audited snapshot, detailed edge cases, and explicitly
  unresolved documentation gaps, read [references/research.md](references/research.md).

## Build the integration

1. Identify the exact application decision. Separate semantic judgment from
   deterministic rules, calculations, state changes, and side effects.
2. Define the smallest relevant JSON `state`. Preserve identities and relations
   with named fields; point questions at nested values with backticked paths such
   as `ticket.messages[0].text`.
3. Define one narrow judgment per named question. Choose Choice for one option
   from a closed set, Noul for probability that one condition holds, and Score
   for position on an ordered qualitative rubric.
4. Put boundary meaning in `criteria`. Include explicit no-match/unknown options
   where the closed set may not cover the input. Use structured objects or arrays
   when contrast, exclusions, or examples would be blurred in prose.
5. Batch independent and speculative questions over the same state in one call.
   Split into another call only when an earlier answer is needed to fetch evidence
   or construct the next question/options.
6. Compose answers in code. Treat probabilities as reusable evidence. Calibrate
   confidence/probability thresholds on representative FrockBot data and match
   review/escalation behavior to the consequence of a wrong decision.
7. Keep questions, criteria, model selection, and threshold constants together
   in a reviewable module. Log the resolved model, usage, decision inputs/outputs
   appropriate to the data policy, request ID when available, and downstream
   route—not the API key.
8. Test the model boundary with an injected client/fetch in unit tests, then run a
   labeled evaluation set for question quality. A typed response proves shape,
   not truth.

## Non-negotiable boundaries

- Keep `TYPESAFE_API_KEY` server-side. Do not use
  `dangerouslyAllowBrowser` in FrockBot clients.
- Do arithmetic, counting, date comparison, exact lookup, authorization, and
  policy enforcement in code.
- Do not ask Jev to generate text. Generate candidates elsewhere and use Choice
  to select when the answer space is bounded.
- Treat input state as potentially adversarial. Precise criteria and tests reduce
  risk; Jev 1.13 does not inherently isolate prompt-injection-like text in state.
- Do not assume separately phrased questions obey arithmetic identities. A Noul
  and a yes/no Choice are different judgments; `P(x)` need not equal
  `1 - P(not x)` across two questions.
- Do not carry a threshold from one primitive, question wording, domain, or model
  version to another without re-evaluation.
- Do not retry a FrockBot-billed or externally consequential model effect outside
  the repository's durable effect/idempotency machinery. The SDK retry policy is
  transport behavior, not an application-level exactly-once guarantee.

## Completion criteria

A Jev change is complete when the semantic boundary is explicit, every question
is atomic and typed, state contains only necessary evidence, uncertainty has a
code-owned policy, secrets remain server-side, model/version and usage are
observable, failure paths are tested, and representative examples show the
chosen thresholds behave acceptably for the feature's risk.
