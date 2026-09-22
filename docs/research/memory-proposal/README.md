# Proposed shared Memory system

Discussion diagrams, not an implemented architecture. The agreed direction is now [shared long-term Memory following Hindsight](../../plan.md#planned-shared-long-term-memory-following-hindsight), built on FrockBot's Cloudflare architecture across User, Bot and Group Chat scopes. These diagrams predate that decision and do not yet show the full evidence, consolidation and generated-topic-page pipeline. The current system is documented in [the startup analysis](../chat-voice-startup.md); [Hermes research](../hermes-memory-assessment.md) informs the small core and explicit recall split.

- [Recall](recall.html): opening context, relevant retrieval, and source expansion.
- [Remember and forget](writes.html): durable writes, immediate visibility, and background indexing.

Both chat and voice use one logical Memory service, with Bot, User, and permitted Group Chat scopes. This does not require one physical Durable Object for all memory. Facts/experiences, consolidated observations and generated topic pages exist within those scopes; working context, compaction and the original conversation history remain separate responsibilities.

The subsequent product decision is to replace Projects with **Group Chats**, shown in the sidebar alongside other chats with multiple member avatars. The diagrams still use the current code's Project terminology. The [Group Chat plan](../../plan.md#planned-group-chats-replace-projects) records the agreed direction; avatar design, the Group Chat interface, and text/voice behaviour are deferred.

Opening a session loads a small prepared core, whose version is checked when used. Query-based recall begins once a substantive message exists. Semantic search through Vectorize and exact/keyword lookup run in parallel; candidate IDs are merged, deduplicated, checked against current authority and record versions, and fitted to a shared context budget. The model can request a source or search transcript history for more detail. Historical statements remain dated evidence, not automatically current facts. Unlabelled arrows indicate ordinary dependencies already expressed by their endpoints; arrows do not represent elapsed time.

Writes publish current records and fast read views before acknowledging success. A durable indexing job is recorded with the change. Recent changes remain available through the exact index and pending-change view while vectors catch up. That bridge does not promise perfect semantic recall before embedding. Forgotten or superseded records are rejected at retrieval even if a stale vector still matches. Background jobs must check versions so delayed work cannot republish obsolete facts.

Still open: physical storage and transaction boundaries; core selection and refresh during long sessions; numerical token budgets; the recall deadline and fallback policy; and how Gemini Live receives retrieved context before a memory-dependent answer. Optional extraction must have its own cost budget and cannot delay acknowledgement of an explicit remember/forget command.

The background index design accounts for [Vectorize's asynchronous mutations](https://developers.cloudflare.com/vectorize/reference/client-api/). Scope filtering should happen before ranking using [namespaces and metadata filters](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/), followed by authoritative permission and freshness checks when reading results.

## Recall throughout a Turn

Requirement from the walkthrough: recall must be available at later model steps, not only in response to the initial User message. A decision to skip the opening search applies only to that decision point. New information may justify a later search.

Proposed mechanisms:

- Keep explicit memory search, source expansion, and conversation-history tools available throughout the Turn. A Bot's explicit recall request is not vetoed by an earlier automatic skip.
- Reconsider automatic recall at useful step boundaries, such as after tool results introduce a new entity, an unexpected problem, or a change in the task. Use the latest evidence and explicit progress alongside the User's objective; the application cannot inspect an unfinished model inference's private reasoning.
- Consider a narrow Jev recall question within the planned shared Turn/step assessments. Batch independent judgments over the same relevant state and overlap them with independent preparation. A start-of-Turn Jev network assessment is planned but not implemented today; new post-tool evidence may require a later assessment. The exact trigger, thresholds, and placement remain design choices.
- Bound repeated retrieval across the active context: reuse still-current results, avoid unchanged searches, deduplicate by memory ID/version, and make room for newly relevant evidence under the shared context budget. Permission and freshness checks still apply. A new step does not get an unlimited additional memory allowance.

The same requirement applies to voice. How Gemini Live pauses, requests, or receives new memory at the appropriate point still needs design. These requirements extend the diagram's on-demand path; its main recall path currently illustrates the initial message only.

The JSON specifications are editable sources. Delivery receipts bind exact specification and HTML bytes. Both workflows passed 9/9 showcase checks with no errors or warnings, browser containment checks at four desktop sizes, and separate light/dark visual review. [Handoff receipts](handoff.json) record those claims separately.
