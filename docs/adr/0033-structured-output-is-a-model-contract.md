---
status: accepted
---

# Structured Output Is a Model Contract

Several Package policies need a typed model result. Conversation compaction is the first: its summary, decisions, open items, and opaque identifiers are distinct values, but ADR 0030 previously asked for Markdown headings and parsed whatever free text came back. Leaving the schema at each caller would make providers disagree about a request, would omit it from the durable normalized request, and would turn validation failure into ad-hoc parsing errors.

## Decision

`NormalizedModelRequest` has an optional provider-neutral `responseFormat`. It is either `{ type: "json" }` or `{ type: "json_schema", name, schema }`. The exact request, including this field, is recorded in `model/request` before provider execution. The kernel declares the shape and validation interface but contains no provider choice or wire translation.

The accepted schema dialect is intentionally small: object, array, string, number, boolean, enum, required properties, and boolean `additionalProperties`, with title and description as annotations. Arrays require `items`; required names must exist in `properties`; unknown keywords fail at the decoding seam. This subset covers the product's current typed results and can be implemented identically without a runtime dependency. Expanding it is a contract change with validator and provider tests, not silent pass-through to whichever endpoint happens to accept more JSON Schema.

Every provider reports its strongest structured-output capability as `json_schema`, `json`, or `none`. A provider may satisfy a schema request natively, downgrade to JSON mode, or use explicit JSON-and-schema prompt guidance. Downgrades emit a typed `response-format-note`; when the Agent loop is the caller, that note is recorded as `model/response-format-note`. The shared model registry always parses and validates the final response itself, even after native strict mode. Invalid JSON and schema mismatch emit `structured-output-failure`, including bounded per-path issues for a mismatch. The Agent records that as `model/response-failed` and treats it as a known completed provider effect, never as an uncertain request requiring reconciliation.

Provider translation stays inside provider Packages:

- The shared OpenAI-compatible transport emits OpenAI/OpenRouter's named `response_format.json_schema` wrapper. Its Workers AI dialect emits the schema directly and requests a non-stream response because Workers AI's JSON mode does not support streaming. The same bounded decoder accepts streamed and non-streamed OpenAI completion envelopes.
- A native Ollama endpoint sends `format: <schema>` (or `"json"`). Ollama Cloud currently has no structured-output support, so its OpenAI-compatible call records the prompt downgrade and relies on the shared validator.
- Frock AI Auto advertises schema support and selects `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for schema requests. Ordinary Auto calls still use the AI Gateway dynamic route. A manually selected Frock model that is not known to support schemas takes the explicit prompt fallback.
- Generic custom OpenAI-compatible endpoints default to `none`, because compatibility of the chat envelope says nothing about support for structured outputs. A provider Package with knowledge of an OpenAI or OpenRouter endpoint opts into the OpenAI dialect and its actual capability.

`ModelInvocation.structured<T>()` is the Package-facing convenience seam. It adds the named schema, consumes the normalized event stream, and returns either a validated typed value with its raw JSON or a typed failure. The conversation compactor uses it for `{ summary, decisions, openItems, identifiers }`, then renders the existing durable Markdown summary so transcript and audit projections do not change. This amends ADR 0030's statement that the summariser itself produces the four headings; the Package now produces those headings from the validated fields.

## Feature rule

1. The Bot Durable Object remains authoritative for admitted conversational model calls and their session events. ADR 0030's compaction intent/outcome remains authoritative for its detached summariser effect.
2. `responseFormat` is durable inside the exact normalized `model/request`; downgrade and failure events are append-only. Compaction retains its existing intent, completed, and failed events.
3. Client disconnect has no effect. Durable Object eviction follows the existing model-effect reconciliation rules, and a validation failure is explicitly complete. Structured output never calls or wakes the Computer.
4. Provider creation is not retried after an uncertain outcome. A typed validation failure is safe to retry only as a new admitted effect under its owning Package's policy; compaction uses ADR 0030's bounded backoff and new effect identifier.
5. The request uses exactly the Bot's resolved model and Connection authority. The schema grants no tool, credential, binding, or network authority. Provider-specific credentials stay inside provider Contributions.
6. There is no new User control or hosted UI. This is a contract used by Packages; capability reporting is provider fact, not a setting. Failures and downgrades project through the existing audit/debug event surfaces.
7. Unit tests cover every supported validator construct, unsupported-key refusal, provider wire mappings, and both streamed and non-streamed response envelopes. A fake-provider integration covers a valid typed round trip and an invalid typed failure, and an Agent-loop test proves the downgrade and failure are durable known outcomes.
8. This is beyond parity infrastructure. Its first use improves parity capability row 50's persistent conversation behavior through ADR 0030 compaction; it does not claim a separately measured GrokBot schema contract.

## Consequences

- Package code no longer parses free-form text when it needs a typed result.
- Provider-native constraints improve reliability but are an optimization; one validator defines success for every provider and fallback.
- Workers AI structured calls are non-streaming at the transport while remaining an `AsyncIterable<LlmStreamEvent>` to the Agent loop.
- The validator is deliberately not general JSON Schema. A future keyword is refused until all participating seams agree on its meaning.

## Sources

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Cloudflare Workers AI supported models](https://developers.cloudflare.com/workers-ai/models/#text-generation)
- [Ollama Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs)
