# Shared long-term Memory

Read the [common rules](README.md). M1–M3 implement the agreed Hindsight-inspired engine on FrockBot's architecture. They do not port Hindsight's entire server or change conversation compaction. [The comparison](../research/hermes-memory-alternatives.md) explains the reference design; this packet defines our implementation direction. Numerical defaults below are initial engineering limits, not measured latency promises.

**Entry points:** [Memory tools and injection](../../app/memory/agent.ts), [store](../../app/memory/store.ts), [facts](../../app/memory/facts.ts), [indexer](../../app/memory/indexer.ts), [searcher](../../app/memory/searcher.ts), [secret refusal](../../app/memory/secrets.ts), [membership seam](../../app/memory/groups.ts), [backend adapter](../../app/shell/backend-memory.ts), [voice memory](../../app/voice/memory.ts), [voice tools](../../app/voice/assistant.ts), [Gemini protocol](../../app/voice/gemini-live.ts), [User FTS pattern](../../app/search/index-store.ts), and the three Cloudflare DO adapters named in the other packets.

## M1: Records and explicit operations

### Ownership and interface

Use the **existing Bot DO for Bot scope and existing User DO for User and shared Group Chat scopes**. Add no Memory DO. Chat reads Bot-local state and makes one bounded User RPC covering User and authorized shared scopes. Voice uses the same owner APIs for its selected Bot; its call ledger is continuity/evidence, not another long-term fact store.

Shared scope is a Group Chat's: the engine's typed `groupChat` scope, keyed by the group's id and authorized by Group Chat membership, which the User object keeps with the User's list of groups. Every read/write checks the authenticated User, selected Bot and current membership on the server. Never trust caller-supplied scope IDs alone.

Keep ordinary app modules for canonical operations, retrieval and projections, with a Cloudflare storage/provider adapter. Freeze these logical operations before splitting assignments:

```text
preparedCore(authority, scopes, budget) -> blocks, manifest, omissions
recall(authority, query, scopes, filters, effort, budget) -> hits, status, cursor?
expand(authority, sourceRefs, budget) -> evidence, omissions
browse(authority, scope, topic?, cursor, budget) -> topic summaries/page
write(authority, scope, content, sources, operationKey, replaces?) -> receipt
forget(authority, scope, itemId | exactKey, operationKey) -> receipt
```

An engine result includes stable IDs, source references, generations, scope, dates and completeness/degradation status. Return typed refusals and unavailability. Empty results mean a completed search found nothing; a failed channel is not an empty successful search. Existing `memory_write`, `memory_forget` and `memory_search` tools adapt to these operations; add `memory_expand` and `memory_browse` for progressive disclosure. Avoid parallel `remember`/`save` tools with drifting semantics.

### Canonical records

Use owner-local SQLite tables and indexed queries. Reuse the existing FTS adapter patterns. Do not add SQL requirements to the generic Session storage interface. Bind SQL parameters and consume cursors within the transaction. Cloudflare supports FTS5; use its storage transaction APIs, not SQL `BEGIN`. Async I/O does not belong in `transactionSync`. See [SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Start with these logical shapes; use one schema initializer per owner and normal typed decoders:

```text
memory_scope(scopeKey PK, generation, invalidationEpoch)
memory_item(scopeKey, id, generation, kind, status, canonicalKey,
            text, subjectKey?, predicateKey?, occurredAt?, recordedAt,
            validFrom?, validTo?, createdBy, confidence?)
memory_source(scopeKey, sourceId, sourceRevision, kind, locator, safeExcerpt?)
memory_evidence(scopeKey, itemId, sourceId, sourceRevision)
memory_relation(scopeKey, fromId, relation, toId)
memory_derivation(scopeKey, derivedId, leafItemId, leafGeneration)
memory_suppression(scopeKey, exactKey, sourceLineage, operationKey)
memory_receipt(scopeKey, operationKey UNIQUE, result)
memory_job(id PK, kind, scopeKey, sourceRef, inputGeneration, state,
           attempt, nextAttemptAt, claimToken?, effectRef?)
memory_projection(scopeKey, name, generation, policyVersion,
                  checkedInvalidationEpoch, body, manifest)
memory_index_intent(scopeKey, itemId, itemGeneration, operation,
                    vectorId, state, mutationId?, nextAttemptAt)
```

Primary/unique keys include scope where IDs are not globally unique. Index active items by scope/subject/time; jobs by state/due time; derivations in both directions; evidence by source identity; vector work by due time. Pagination uses stable ordered keys, not increasing offsets over a mutable queue. Cap individual text/source payloads at the existing tool limits, and page collections.

`kind` is `fact`, `experience` or `observation`. Facts are compact assertions; experiences are dated events; observations synthesize evidence. Prepared core, chronological listings and topic Markdown are **derived views**, not additional authored memories. Preserve separate evidence links when several sources support one fact. Do not collapse distinct dated experiences because their wording is similar. `canonicalKey` only deduplicates deterministically equivalent content within one scope; embeddings do not establish equality.

Source locators identify exact evidence: Bot/Session/run/event sequence or voice call/spoken-turn sequence, plus revision. A locator never grants access. Expansion rechecks source authority and reports unavailable evidence when original material has expired; never invent an exact quote from an observation. Keep a bounded, secret-checked evidence excerpt when needed for durable provenance, with explicit distinction from the full original transcript.

### Mutation ordering and invalidation

1. Check authority and existing operation receipt. Validate content/source limits and reuse `refuseMemorySecretV1` before persistence, extraction input or embedding. It detects obvious credential shapes; it is not a complete secret scanner. Do not copy credentials or credential references into evidence, logs or vectors.
2. In one owner transaction, apply the canonical mutation, receipt, scope generation, immediate FTS changes and required pending jobs/index intents. Update the existing owner's alarm deadline transactionally where supported; follow S3's durable wakeup contract. External embeddings, model calls and other DO RPCs happen afterward.
3. A correction creates a successor with `supersedes` and marks the replaced assertion inactive for current recall. Corrections, every active-to-inactive/superseded transition and source-authority loss must advance the applicable invalidation fence synchronously; membership revisions also participate in shared-scope cache validity. Retain the dated evidence needed to explain the change. A conflicting independent assertion remains evidence; consolidation must represent the disagreement rather than silently select whichever embedding is closest.
4. Forget makes the selected item/key ineligible immediately, records suppression against replay of its old source lineage, advances `invalidationEpoch`, and queues vector deletion and affected-view repair. A delayed extraction job must not recreate it. Only a new authorized explicit write can override an applicable suppression; index/rebuild jobs cannot.
5. Each observation or topic-page section carries a complete flattened leaf-item generation manifest, capped at 32 leaves. Split an oversized observation into smaller independently supported observations; do not hide its extra dependencies behind a parent summary. Large topics are paginated sections: each returned section, including any derived title/summary, validates its own manifest. Return at most two sections per browse page and include their validation reads in the request budget. The directory holds section IDs/generations, not an unchecked aggregate summary. On an invalidation-epoch mismatch, validate the bounded manifest against canonical rows before returning content. Any inactive, changed or inaccessible leaf rejects that content. Repair reverse dependencies in background indexed batches: do not traverse an unbounded dependency graph inside the forget transaction.

Preserve existing writer authority: the Bot's ability to contribute to User/shared memory does not authorize rewriting every other Bot's evidence. Resolve explicit User corrections through the authenticated User command path. An inferred private Bot observation stays in Bot scope. Promotion to another scope is explicit: destination creation with a stable operation key and `promotedFrom`, then optional source retraction only if a move was requested. There is no cross-DO atomic move; retry an uncertain destination receipt before changing the source. The destination must contain independently authorized promoted evidence, not a hidden reference that grants access to private source material.

**M1 acceptance:** exact/lexical read-after-write works without Vectorize; duplicate operation keys return one result; separate scopes and memberships cannot leak; correction preserves provenance; forgotten evidence cannot return through derived records or replay; arbitrary source IDs cannot bypass expansion authorization. Exercise eviction and rollback. M1 supplies the tested foundation; the coherent live cutover is M3.

## M2: Background processing

### Capture, extraction and consolidation

At chat settlement or sealed voice-call range, record an extraction obligation and source-retention reference with the authoritative source change. For a different destination owner, use an acknowledged outbox keyed by source identity/range; receiver admission is idempotent. Release source retention only after the required consumer acknowledgement, which must mean the receiver has durably captured sufficient source material or completed processing, not merely stored a pointer back to deletable evidence. Terminal failure retains that material and exposes retry/failure through existing audit/work surfaces. Only an authenticated explicit abandonment/deletion or an authorized scoped cleanup may dispose of an unfinished obligation and its retained source; retry exhaustion alone cannot. Startup does not extract or scan old conversations.

Use each owner's existing alarm/scheduler, including UserConfiguration's existing housekeeping deadline, rather than replacing its alarm. Drain bounded due jobs; start with eight local jobs or one external operation per invocation, matching S3. Persist a claim token/input generation and enough source identity to recover after eviction. Commit results only if the claim, scope authority and input generation still match. Backoff and durable continuation follow S3; terminal failure is explicit and does not silently discard protected evidence.

Extraction and consolidation are paid model work. Reuse the existing admitted model/effect and accounting path, record exact input references and prompt/schema/model versions before dispatch, and handle uncertain outcomes through its existing policy. Persist the originating Bot/Turn principal on the obligation; voice uses its selected Bot. That principal determines spend, model selection, grants, cancellation and audit attribution. Subject consolidation inherits the principal of the source job that scheduled it; do not select an arbitrary current Bot at drain time. Recheck principal existence and destination membership before dispatch and commit; loss of authority makes the job explicitly blocked/cancelled under the retention rule above. Do not create a direct provider client, new model-selection setting or new Jev gate. If the admitted model path requires a Bot Turn, run a bounded background Turn through that recorded Bot instead of bypassing metering from User DO.

Extract small proposed facts/experiences with exact source links; deterministically validate scope, source existence, secret refusal and replay suppression before committing. Consolidate changed subjects, not the entire memory bank: produce observations with leaf manifests and typed `supports`, `contradicts`, `supersedes` and `about` relationships. Keep model-inferred confidence separate from a claim being verified. Never combine private source material into a broader-scope observation.

### Prepared core and topic pages

Generate topic pages from canonical records; expose read-only Markdown through `memory_browse` or a virtual file adapter. Writes still use canonical operations. Do not maintain editable topic files beside editable dated fact files. The chronological browser queries experiences/time indexes over the same records.

Build the small core in background with deterministic selection: explicit current profile/preferences first, then supported useful observations, stable ID order for ties. Include permitted User/Bot/shared contributions under one total budget. Its bounded manifest and policy version make it reusable after eviction. An additive change can leave a valid older core temporarily available; corrections/forget/authority loss immediately fence invalid content. Omit an invalid core section and enqueue repair rather than performing a startup rebuild. Use stable output when sources have not changed to preserve prompt-prefix reuse.

### Vectorize as a derived semantic index

Commit canonical rows and index intents first. Vector IDs include scope, item identity/generation and embedding-policy identity; reuse the configured embedding model/dimensions. Coalesce obsolete intents per item while retaining necessary old-vector purges. Run embeddings outside the owner transaction, then recheck the generation before publishing. Namespace/filter by the authorized owner/scope **before top-K**, and hydrate every returned ID from its canonical owner afterward.

Vectorize mutations are asynchronous. A returned mutation ID is not proof that the next query sees the change. Retain durable pending visibility state and bounded reconciliation; do not drop it just because it is old. Clear pending visibility only through a documented mutation-completion acknowledgement covering that operation. Verify the installed binding's supported mechanism; opaque mutation IDs must not be ordered lexicographically. A top-K query or `getByIds` response is not that acknowledgement, and absence from a query never proves deletion. If completion cannot be established, keep compact durable reconciliation state, expose unconfirmed semantic coverage and use the exact/FTS path; report that adapter limitation. Submitted mutations need not be reissued on every poll. Canonical tombstones and suppression remain authoritative regardless of index acknowledgement. See [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/).

Until visibility is confirmed, exact/FTS/time queries already see committed items. Merge a bounded pending-item candidate page into recall, optionally scoring stored embeddings only when their policy matches the query embedding. Report partial semantic coverage if the backlog exceeds that page; do not promise perfect semantic read-after-write. Old vector hits always undergo active-status, generation, scope and derivation validation, so a delayed delete cannot resurrect forgotten knowledge. Rebuild from canonical records with a cursor and durable vector ledger, not from generated Markdown.

**M2 acceptance:** delayed or duplicate jobs do not duplicate facts or spend; late results cannot overwrite corrected sources; forgotten sources block extraction/consolidation reintroduction; core/pages have complete valid manifests; delayed upsert/delete and failed embeddings preserve exact recall and accurate degraded status. Maintenance progresses after eviction without another message. Test multiple shared scopes and User/Bot isolation.

## M3: Recall and context integration

### Retrieval algorithm and budgets

Use a single request budget across scopes and channels, not a fresh limit for every Bot, Group or model step. Execute authorized FTS, semantic and explicit time-filter searches concurrently within the shared limiter. Expand relationship neighbors from these seeds in one bounded hop; graph recall depends on seeds and cannot honestly run before they exist. Honor explicit dates in the query filters; do not treat newest as inherently most relevant.

Hydrate and filter canonical candidates before ranking. Fuse channel ranks with reciprocal-rank fusion (`sum(1 / (60 + rank))`), deduplicate by item ID, and prefer a valid concise observation when it covers the selected evidence. Preserve conflicting active evidence with dates/source IDs instead of concealing it behind one summary. No extra LLM reranker in the initial implementation. `memory_expand` obtains exact supporting detail only when needed.

Put these starting defaults in one typed policy module and test the boundary cases:

| Limit                               | Initial default                                                   |
| ----------------------------------- | ----------------------------------------------------------------- |
| Prepared core                       | 1,024 tokens total across scopes                                  |
| Active recalled/expanded blocks     | 2,048 tokens total, deduplicated across steps                     |
| Total Memory contribution           | 3,072 tokens including core, citations and tool-result wrappers   |
| Candidates                          | 20 per channel, at most 80 hydrated candidates across all scopes  |
| Graph/evidence expansion            | 1 hop, at most 32 additional records within the same request cap  |
| Concurrent external retrieval calls | 4                                                                 |
| Automatic retrieval                 | 1 initial search, at most 2 additional searches per Turn          |
| Automatic search deadline           | 750 ms, returning completed channels with explicit partial status |
| Explicit search/expansion deadline  | 3 seconds                                                         |

Suballocate those totals before dispatch. Bound namespaces, pages and query bytes too; with more eligible scopes than fit, select explicit scope first, then deterministic fair pages with an omission/cursor marker. Never search an unauthorized aggregate namespace and filter only afterward. Explicit scope queries let the model reach an omitted shared scope. Do not silently add an account membership quota to solve retrieval fan-out.

Use the selected provider's tokenizer where already available. Otherwise apply a conservative UTF-8-byte upper bound plus wrapper allowance and label recorded counts as estimates; a casual characters/4 heuristic is not a hard token cap. Clip on complete item boundaries, return omissions and expansion references, and include all persistent retrieval blocks/tool results in the next request's accounting. Prevent repeated searches from accumulating unlimited copies in working context. Keep the immutable execution journal intact while rendering bounded app-owned Memory result blocks into model context.

Cache query results by normalized query, authorized scope set, membership/invalidation generations, embedding policy and filters. Recheck current authority and manifests before use. Log IDs, generations, counts, channel status and budget consumption using the existing audit conventions; do not log sensitive full source text by default.

### Chat integration

S4 preparation reads the prepared core without directory/file walks. Initial bounded automatic recall runs for substantive new user requests, before the first model request. A deterministic local check may skip empty/control-only input; do not introduce a paid classifier or infer that a greeting always needs a search. A timed-out channel yields valid partial results and a reported status, not a Turn failure.

Keep explicit tools available on every model step. For later automatic recall, expose a step-boundary hook after a completed tool-result batch and before the next model request. Initially derive a bounded query from the user's current request plus new structured entity/source names in those results; skip unchanged query signatures and obey the per-Turn search count. Treat tool text as data, never instructions to widen scope. This is an engineering baseline; a Jev decision gate remains a separate assignment. Do not attempt to inspect hidden model reasoning or interrupt an in-flight model request to inject memory.

Place newly retrieved blocks near current work, after the stable instructions/core prefix. Record IDs/generations and reuse unchanged blocks. Before subsequent model requests, remove invalid app-owned Memory blocks and represent withdrawn Memory tool content as unavailable while preserving tool-call/result pairing and the immutable audit journal. Do not rewrite a dispatched request or blindly redispatch an uncertain effect. Forgetting Memory is not automatically deletion of the original user conversation; that is a separate data operation.

### Voice integration: use the actual provider protocol

Opening loads the same prepared core as chat. Expose `memory_search`, `memory_expand`, `memory_browse`, write and forget through the existing Gemini function interface and selected-Bot authority. Memory lookups use the default **blocking** function behavior; omit `NON_BLOCKING` for these declarations, while preserving it where already appropriate for other tools. Return results against the real function-call ID. Gemini's default behavior pauses generation awaiting that function response; see [Live API tools](https://ai.google.dev/gemini-api/docs/live-api/tools).

A finalized input transcript may trigger bounded automatic **prefetch** into an attempt/utterance-scoped cache. The function handler consumes that result after authority checks or performs the bounded query itself. Cancel and discard prefetch on attempt replacement. Receiving a transcript does not establish that Gemini has not already begun answering: do not promise pre-answer injection from that callback, send invented tool responses, or splice arbitrary context into an undocumented protocol message.

**Remaining product/protocol decision:** guaranteed automatic recall before every relevant voice answer requires an explicit Live turn-control design. Deliver the supported core + blocking-tool + prefetch path in M3, report this limitation, and leave that guarantee open for review. Do not mark it solved by prefetch or silently change microphone streaming/admission behavior to create a gate.

Ordinary recall uses tool responses without restarting a valid resumable session. Destructive Memory invalidation or withdrawn membership is different: invalidate affected prefetch/core/resumption references and, where already injected content cannot be withdrawn, use S6's clean reopening with valid bounded continuity before further upstream work. Never replay uncertain audio or tool effects. Resumption cannot override access withdrawal.

### Coherent cutover and acceptance

M1/M2 build the new foundation through isolated tests. M3 switches all live chat and voice Memory writers/readers together: explicit tools, Plugin memory grants, backend injection, background extraction, search, browsing, and any workspace/UI edits to old Memory files. Inventory these paths with `rg` before editing; an R2 writer left behind would create a second truth. Retire old authored Markdown fact roots and the separate voice long-term fact shape with their indexes/jobs. Preserve ordinary workspace files, authoritative transcripts and call continuity. Remove old code/decoders; no import migration, indefinite dual write or legacy read fallback. Include scoped repeatable cleanup for incompatible disposable test data in the authorized release.

Prove with fixed fixtures: User preferences cross Bots; private Bot facts do not; shared facts require current membership; recent unindexed facts are accessible; exact names, semantic paraphrases, dates and linked evidence each retrieve useful results; contradictions remain visible; correction/forget prevents stale vectors, observations, topic pages and cached blocks from reappearing. Test source expiry, partial-channel failures, large scope counts, multiple compactions, later-step recall and every budget/deadline boundary.

For voice, test a real-shaped blocking function call/response, transcript prefetch racing generation, stale-attempt results, selected-Bot switches, invalidated resumption and shared write/forget visibility in chat. Assert no startup extraction or unbounded Memory file/archive scan. Report the automatic pre-answer voice limitation explicitly. These tests establish correctness and bounded work; they do not claim that this port inherits Hindsight's measured quality or latency.
