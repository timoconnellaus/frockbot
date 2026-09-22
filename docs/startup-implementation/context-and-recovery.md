# Bounded context and durable admission

Read the [common rules](README.md) first. This packet covers S2 and the chat half of S3. The [voice packet](voice.md#s3-voice-recovery) covers voice recovery. Keep the newer active-effect index/private-chunk batching proposals outside these changes.

## S2: Working context

**Entry points:** [Session](../../core/contracts/session.ts), [Turn history](../../core/contracts/turn-history.ts), [SessionEventLog](../../core/durable/session-event-log.ts), [durable authority](../../core/durable/authority.ts), [history selection](../../app/shell/history.ts), [compaction](../../app/shell/compaction.ts), [compaction scheduler](../../app/shell/compaction-scheduler.ts) and [Turn assembly](../../app/shell/turn.ts).

### Establish an explicit Session seed first

Current `Session` assumes `seq === array index`, allocates sequence numbers from `events.length`, and discovers the next Turn from the array. Recovery, history and completion have related assumptions. **A truncated `previousEvents` array is not a valid implementation.** Preserve absolute event and Turn identities.

Replace that implicit contract with these separate inputs:

```text
SessionCursor: sessionId, epoch, nextSeq, nextTurn
CommittedContext: summary + selected complete normalized Turn messages
ActiveRunJournal: exact events for the currently executing/recovering run
ArchiveReader: explicit bounded ranges, only for history/audit/recovery consumers
```

Expose normalized messages/cursors at the core interface; keep Shell history policy in the app. Rename the old full-array accessor so its consumers fail compilation. Audit `session.events`, `previousEvents`, array length/slice and next-Turn derivation in core, Shell, Memory, Skills and Plugin hooks. Assign every consumer to context, exact active-run journal or archive access. Completion suffixes use absolute sequence boundaries. Preserve batch child/result handling and tool occurrence identities.

The active-run journal may be large under current semantics; this task removes retained **previous-run** payloads from startup. It must not silently cap current work or change per-effect admission. Pending model recovery uses the exact recorded request, binding and replay data, never a request regenerated from today's context.

### Projection and storage

Use the existing Bot DO and transactional KV for the conversation projection. `SessionEventLogStorage` exposes KV operations, not SQL. Add ordered bounded-list options where needed; keep host SQL out of generic Session/contracts and their in-memory fakes. Memory's separate owner-local SQLite tables do not require rewriting this seam.

Add a pure working-context reducer/selector under `app/shell/` and a narrow store over the existing transaction interface. Recommended records:

| Record               | Required contents                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation head    | Absolute cursor, projection revision, exclusive `projectedThroughSeq`, compaction reference/coverage, Turn counts, open-run reference    |
| Turn context index   | Turn ID/type, source sequence range, full/pruned character costs, normalized message-page references, message-bearing flag               |
| Message pages        | Complete normalized messages with provider replay fields, attachments/references and tool IDs/results; pages bounded by stored byte size |
| Compaction reference | Exact summary text, covered sequence/Turn boundary and source epoch/revision                                                             |

Complete messages are a logical guarantee, not a single-value requirement. Reuse the event store's bounded payload chunks and length/hash-reference pattern for oversized normalized messages; reassemble exactly when selected. Never truncate or refuse previously valid current-Turn content solely to fit a projection page. Extend size-limited storage tests to projection writes as well as original event writes.

1. Update head/index/pages with the authoritative event append in the same transaction. Extend the existing `eventRecords`/terminal contribution interface if it cannot perform the necessary reads/writes. Cover loop commits, direct tool Turns, voice transcript insertion, announcements, failed/cancelled terminal paths and compaction.
2. Treat replayed projection ranges as no-ops; reject gaps and inconsistent epochs. Empty/private-chunk events can advance the projection cursor without becoming prompt messages. Do not hydrate exact historical `model/request` bodies simply to update a prompt projection.
3. Preserve `CHAT_HISTORY_BUDGET_CHARS_V1`, whole-Turn selection, pruning rules, newest verbatim-tool Turns and omission wording. Select from metadata before fetching the chosen pages. Retain the representations needed when an older Turn becomes eligible after pruning; using only the last N visible messages is incorrect.
4. Keep summary bytes unchanged until a committed compaction. Compaction may read its covered archive independently in the background. Commit summary/coverage and context revision together, checking the expected epoch and covered tail. Preserve the single Session writer when detached compaction yields to new input.
5. A missing/corrupt projection gives an explicit unavailable/repair state. Schedule bounded reconstruction, or use scoped disposable-state cleanup at release. New input can remain durably admitted while repair prevents unsafe execution. Ordinary startup must not repair by synchronously reading the entire archive.
6. Add a selected-Bot voice-context read that returns its bounded visible excerpt directly, instead of general run pages followed by truncation. Keep private model scratch out of voice. Index voice turns by `(callId, sequence)` and continuity jobs by state/due order; call history loading must not list all retained calls.

### Acceptance

Build golden request fixtures from the existing context builder before replacing it. Compare complete normalized requests for short history, multiple compactions, tool pairs, batch results, attachments, provider replay and long current Turns. Use the old builder only in tests as a temporary oracle, then remove it once fixed fixtures cover the behavior; do not ship a second runtime path.

Use fake storage that fails an unbounded archive read. Many retained old runs must not increase the context/admission records fetched. Test eviction after every projection commit, duplicate range application, missing pages, stale compaction and archive expansion. Extend `core/durable/session-event-log.test.ts`, `session-log-size.test.ts`, `session-flush-reads.test.ts`, Shell history/compaction tests and `apps/cloudflare/test/voice-history.workerd.ts`.

**Done when:** new Turns use the explicit seed and bounded projection; equivalent context is preserved; exact recovery and original history still work independently; no production full-history compatibility path remains.

## S3: Recovery and admission

**Entry points:** `run`, `acceptRun`, queued-run promotion, `recoverActiveRun`, `alarm` and `refreshRecoveryAlarm` in [authority.ts](../../core/durable/authority.ts); [app/shell/turn.ts](../../app/shell/turn.ts); [backend recovery](../../app/shell/backend-recovery.ts); [BotState](../../apps/cloudflare/src/bot-state.ts).

1. Separate durable admission from driving execution. Remove the old-run execution await before admission. Admission reads the S2 head, current run headers, relevant queue state and required settings/authority, rather than full event-log migration/hydration.
2. In one transaction, record the incoming command fingerprint/receipt, run, queue/supersede intention, relevant visible status and future wakeup. Preserve User precedence, agent FIFO/capacity, background refusal and the existing rule governing supersession before a model intent exists. Maintain a small `hasModelIntent` header if that decision needs it; this is not permission to redesign all effect admission.
3. After commit, signal resident cancellation and kick the driver as an optimization. An input acknowledgement must not wait for previous inference/tools. Keep completion-waiting Bot/agent callers explicit: return a durable admission receipt to submitters, and use a separate wait/result operation where the caller really needs the completed answer. Update callers and wire contracts together; an accepted run is not a completed result.
4. The single driver reconciles the previous active run before promoting work. Honor durable Stop/supersede and uncertain paid outcomes. Never execute two Turns concurrently in one conversation merely to make admission faster.
5. **Queued pin rule:** configuration/composition/Skill/catalog versions already admitted stay pinned; conversation context is selected when that queued Turn actually starts, so it sees intervening completed conversation. Current `promoteQueuedRun` reads the latest composition pointer: change that behavior deliberately to honor the agreed admitted-version contract, and test artifact retention/unavailability. Current revocations still apply at use. Requested composition and actually mounted fallback remain separate recorded facts.
6. Remove unrelated execution recovery from transcript/context/snapshot reads. Reads return the committed state. Durable obligations, not a person reading the page, drive recovery.
7. Extend the existing alarm selector with due indexed repair/recovery/publication work. When using Bot storage, commit pending records and the alarm update through its existing transaction-aware alarm owner. Preserve all other contributed deadlines. Do not add an independent `setAlarm` caller.
8. Drain committed publication before the alarm's current execution-in-flight early return. Publication does not execute a new Turn and must continue while a long Turn is running. Bound local maintenance batches and re-arm while work remains. Keep external I/O outside storage transactions and release per-operation serialization before waiting on providers.
9. Retire completed one-off constructor cleanup only after checking its release receipts. Required initialization stays before access; historical cleanup moves to the scoped release path, not to a detached promise.

### Acceptance

Extend Turn admission/supersede/retry tests, workerd admission tests and any affected internal caller tests. Hold the old provider call unresolved and prove the new command is acknowledged durably. Evict after admission before the in-memory kick; the alarm must continue the recorded work. Exercise Stop/supersede races, retries with the same command, background/agent lanes, queued artifact changes, exact pending-request recovery and one active Session writer.

Test that transcript/context reads cause no provider or tool dispatch. Inject a rollback after pending-index writes and prove neither the obligation nor its projection is half committed. Exercise simultaneous contributed deadlines and publication while execution is active. **Done when:** admission is bounded and independent of historical execution, required reconciliation still precedes unsafe effects, and recovery progresses without another request.
