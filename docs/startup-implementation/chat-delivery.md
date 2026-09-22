# Direct committed chat delivery

Read the [common rules](README.md). S5 depends on S2/S3's context, read-only snapshots and alarm interface. It begins at a committed explicit send; model generation/whole-step tool execution remains unchanged.

## S5: Committed updates

**Entry points:** `sendToUser`/send commitment in [app/shell/agent.ts](../../app/shell/agent.ts), transaction hooks in [authority.ts](../../core/durable/authority.ts), [BotStateChannel](../../apps/cloudflare/src/bot-state-channel.ts), [run protocol](../../app/shell/run-protocol.ts), [wire schema](../../core/protocol-schemas/schema/client-wire.schema.json), and Flutter [state channel](../../apps/native/lib/client/state_channel.dart), [transport](../../apps/native/lib/client/transport.dart), [chat controller](../../apps/native/lib/client/chat_controller.dart), [transcript](../../apps/native/lib/shell/transcript.dart).

### Commit the visible projection and publication together

Use these logical records on the Bot DO:

```text
PublicationHead: epoch, firstRetainedCursor, lastCursor, broadcastThrough
ConversationRow: stable Session/run/send identity, revision, committed payload
ConversationUpdate: epoch, cursor, kind, entityId, revision, typed payload
PendingPublication: lowest cursor still needing a broadcast attempt
```

`kind` distinguishes message, run/status, announcement and card-revision changes. Use a validated discriminated union; `unknown` payloads are not the final wire contract. A cursor belongs to a publication epoch, so cleanup/reset cannot accidentally accept a cursor from a previous store.

1. Allocate cursor, update the visible projection, append publication event and mark pending publication **in the same transaction as the authoritative change**. Use explicit commit contributions, replacing `observeRuns` storage interception as the source of chat delivery. An observed storage call is not proof its transaction committed.
2. Inventory every visible writer: input admission, explicit sends, voice announcements/transcripts, run terminal outcomes, approval/card creation and card revision changes. Cover each through the same transaction-owned publication path. Private model chunks create no transcript/card event.
3. Stable ordinary-message identity includes Session, run and send occurrence. One ordinary send creates one bubble regardless of retries, replay or frame splitting. Preserve the existing card exception: repeated sends for one `surfaceId` update the card in its original visible position, rather than adding bubbles. Snapshots, replay and older-page loading must use the same card identity rule as `dedupeCardSendsV1` in the native transcript model. Updates mutate the named entity only when their revision advances.
4. Reconstructable obligations may point to immutable committed payloads rather than duplicate large bodies. Retain those payloads while publication/replay references them. Keep ordering consistent across concurrent writers on this DO.

### Deliver after commit and recover after interruption

After commit, drain ordered pending publications over the existing hibernating observer sockets. Visible messages bypass the 250 ms generic activity throttle; low-value status updates may still coalesce. Do not wait for client acknowledgements or allow one slow reader to hold a Turn open.

Advance `broadcastThrough` after attempting broadcast. It records an attempt, not delivery to every client. A crash after send but before the marker can repeat frames; client deduplication handles that. The S3 alarm owner recovers pending publication even while a long Turn is active. With no connected clients, mark the attempt complete and rely on retained replay/snapshots for later readers.

Keep a bounded replay window by both count and bytes. Begin with the existing 64-event retention count; use a named total-byte bound suitable for real rich payloads. Do not delete an undrained obligation simply to fit replay retention: pending publication and replay retention are separate lifetimes. When a reader is behind retention, return an explicit reset rather than skipping ahead.

### Snapshot plus stream protocol

1. Read committed visible rows, pagination position, epoch and cursor from one transaction/snapshot. Reuse existing page count/byte bounds where applicable. An independently loaded page paired with a later cursor can lose updates and is invalid.
2. Load this snapshot once, then subscribe from its cursor. Socket registration and backlog selection must close the gap between replay and live delivery. Updates committed during initial loading are replayed after the snapshot cursor.
3. Reject gaps, epoch mismatch and stale revisions. A reset produces one replacement snapshot; the client discards conflicting partial replay state. Prevent a slow old snapshot overwriting later applied updates by tracking a synchronization generation.
4. Define the frame byte bound in the shared schema. The existing small notice limit cannot carry all valid messages. Keep a bounded multipart envelope for oversized updates, including event identity, part count/index and byte limit. Advance the logical cursor only after complete validation/assembly. Reset on missing, inconsistent or expired parts; reconnect may safely replay the same logical event.
5. Preserve authentication and Bot scoping on handshake and replay. A publication cursor is not authority to read another Bot's state.

### Flutter reducer and cache

Replace broad `invalidate()` on every notice with typed application of committed updates. Target card refreshes by surface/revision. Fetch old history or detailed audit data only when requested, not on each reply.

Store the bounded conversation cache, epoch and cursor coherently in one envelope. If persistence fails, keep the last durable cursor with its matching durable cache; a later reconnect may replay already-rendered events and deduplicate them. Never save a cursor beyond recoverable cached rows. If cache is absent/corrupt, reset with a snapshot.

Preserve pending-command reconciliation, unread IDs, cancellation and retry states. Use existing stable row/widget identities so measured heights, focus, scroll anchoring and serialized older-page loading survive incremental updates. Apply older pages by identity/order; they cannot overwrite a newer live revision.

Update source wire schemas and run the existing TypeScript/Dart generators. Follow the release/minimum-client policy in the common rules; remove superseded decoders as part of the coordinated protocol change.

### Acceptance

Extend core Bot-state-channel protocol tests, workerd channel tests, native `state_channel_test.dart`, chat-controller tests and transcript tests. Prove:

- A committed send renders without a transcript GET; private chunks cause no transcript/card refresh; only a changed card refreshes; initial synchronization reads one page.
- A rolled-back send produces no visible event. Crash after commit/before broadcast, after broadcast/before marker, and after cache application/before cache persistence loses no message.
- Duplicate, gapped, out-of-order, multipart and expired-retention delivery produces correct ordered bubbles or an explicit reset.
- Snapshot/live races, reconnect/eviction, publication during active execution, announcements and terminal outcomes behave correctly.
- Rich payload limits, unread/pending identities, measured row heights, focus and older-page scroll position remain correct.
- Repeated sends of the same card surface update one existing row, including after snapshot/replay and older-page loading.

**Done when:** all visible writers participate, commitment precedes publication, every pending update has recovery, and ordinary reply rendering needs neither broad invalidation nor a transcript refetch.
