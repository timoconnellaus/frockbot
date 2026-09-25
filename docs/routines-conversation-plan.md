# Conversation-authored Routines

Landed. Current shape is [architecture.md](architecture.md) §6 and §8; the
authoring decision is [ADR 0033](adr/0033-conversation-authored-routines.md).
This page is the cut sequence that got there.

Routines stay a first-party app feature. What changed is who writes them, and
what happens to a connected-app event before it spends a conversational model
Turn.

Cut 3 already delivered `{ kind: "connection", connectionId, triggerType, config? }`
and the deployment-wide events door. This plan was the next slice: the editor
went, conversation is the only author, and Jev may drop a clearly unrelated
event before the Bot's model runs.

Each cut leaves production Bots able to reply.

## Outcome

- A User asks the Bot to set up, change, or retire a Routine. There is no
  create/edit form.
- The Routines page is a list and a read-only detail: name, instructions,
  trigger in words, optional provider `config`, recent runs. Pause, resume,
  delete, run now, and webhook rotate/revoke stay chrome.
- A connected-app event is one candidate. Jev classifies the standalone
  payload against the Routine prompt. A clear miss is a skipped firing, not a
  Bot Turn. Anything else fires as today.
- Jev does not fetch the Gmail thread, does not read the FrockBot chat that
  created the Routine, and does not write a separate `match` field. The prompt
  is the description of what kind of event this is for.

## Settled decisions

Do not relitigate these without a reason that is new.

1. **Conversation authors. The list does not.** No New Routine, no editor, no
   "tap to cite this Routine in chat." Changing the prompt is something the
   User says to the Bot.
2. **The prompt is the match.** No second field. The Bot writes the prompt so
   it names the kind of event ("when a shipping confirmation arrives, file the
   tracking number"). Jev reads that plus the event payload.
3. **Jev is a rejector, not a matcher.** Two labels only: `clearly_unrelated`
   and `is_or_might_be`. Only `clearly_unrelated` skips the Turn. Short replies,
   `Re:`/`Fwd:`, empty-ish bodies, and calendar-style accepts are not a clear
   miss — the Gmail thread may hold the meaning, and Jev does not have it.
4. **One event is one candidate.** A poll that finds three messages is three
   `trigger.message` deliveries, three classify calls, up to three firings.
   Inbox sweeps stay a schedule (`@hourly`, then fetch). Do not batch.
5. **Connection triggers only.** Webhook and plugin triggers already have a
   door or a Plugin that can drop. A clock has no payload to classify.
6. **Classify on drain, before the conversational model.** The events door
   stays fast: enqueue first, keyed by event id, as Cut 3 already does. Jev
   runs when the scheduler claims the firing, before `admitTurnV1` spends a
   model call. A drop settles the firing as `skipped`.
7. **Fail open toward a Turn. Never drop on a Jev miss.** Unavailable or a
   timeout is not `clearly_unrelated`. A timeout is an ambiguous paid outcome:
   record it under the event id and do not retry under a new identity
   ([Jev plan](jev-supervision-plan.md)).
8. **No provider knobs in chrome.** The detail may _show_ a `query` the Bot
   wrote. It never asks for `labelIds`, `userId`, or `interval`. `userId` is
   `me`; the poll interval is the provider default.
9. **`userAsked` stays for Routines the User already created.** New ones are
   Bot-authored. Do not rewrite stored `createdBy`. Pause/delete in the list
   remain User chrome and need no `userAsked`.

## Why these seams

### The editor is the wrong author

`routine_manage` already hits the same commands the client hits
(`app/routines/agent.ts`). The Flutter editor cannot express `config`, invented
`connection:<connectionId>:<triggerType>` timing strings, and is what would
force label ids onto a form. Deleting it is the product move, not a cleanup.

The list already has the row (name, timing, pause). Everything else — run now,
the log, rotate/revoke, delete — lives on the editor the row opens
(`app/routines/routines-document.ts`). That moves onto a detail the row opens
instead. Same actions, no fields that write a Routine.

A webhook key is still minted once and shown once, on the receipt. Rotate
stays on the detail; the host still holds the banner
(`apps/native/lib/routines/page.dart` `mintedKey`). A secret the authority
minted once is still never in a document.

Empty list: "Ask this Bot to set up a Routine." No FAB.

### Classify is not Turn supervision

`TurnSupervisor.startTurn` runs _after_ a Turn is admitted and today returns
the conservative default without calling Jev (`app/supervision/jev.ts`). Using
it as the inbox filter would still occupy the Bot with a Turn identity, a cue,
and the one-run lock for work we intend to skip.

Do not add this question to `startTurn`. Add a narrow judge beside the existing
call-review eval:

```ts
type RoutineEventVerdictV1 = "clearly_unrelated" | "is_or_might_be";

interface RoutineEventJudgeV1 {
  classify(
    evidence: RoutineEventEvidenceV1,
    signal?: AbortSignal,
  ): Promise<RoutineEventVerdictV1>;
}
```

Hosted adapter: one Choice question, same Jev pin style as
`app/evals/call-review.ts`. Tests: a fake. Unavailable: the hard-unavailable
adapter that never returns `clearly_unrelated`.

The scheduler's `execute` closure (`settleRoutineFirings` in
`app/routines/bot.ts`) is the one caller. Before `admitTurnV1`:

1. If the firing is not a connection trigger, admit as today.
2. Classify, keyed by the event id already on the firing's discriminator.
3. `clearly_unrelated` → `{ status: "skipped", summary: "…" }`. No Turn, no
   conversation line, no failure notification.
4. Anything else → `admitTurnV1` as today.

Plugin-trigger drops stay a receipt _before_ enqueue, because the Plugin is
asked in the door. Jev is slower and paid; putting it on the Composio POST
would hold the door. Drain is the right time.

### The thread Jev does not have

A Gmail event is one message: subject, sender, snippet or `message_text`,
`thread_id`. That is enough for "Your Amazon order has shipped." It is not
enough for "Yes." The earlier messages live on the Gmail thread. Jev cannot
fetch them, and the kernel must not fetch the thread on every poll hit to help
it.

So the question is "is this _clearly not_ what the prompt is for?", never "is
this a match?". Evidence is bounded: Routine name, prompt, trigger slug, and a
small projection of the payload (subject, sender, to, snippet/text, labels).
Strip the raw Gmail `payload` object. No FrockBot chat, no thread fetch.

False drop is the failure that matters. False keep is a Turn we were going to
pay anyway.

### Queue pressure

One Routine still runs one firing at a time; extras queue, cap 8, then skip
(`app/routines/storage-keys.ts`). Classify-on-drain means a burst of
newsletters occupies those slots for a Jev call each, then skips. A ninth event
in that window can hit the cap. That is the existing valve, not a new one. Do
not classify before enqueue in this slice to "save" those slots — measure
first. If a busy inbox skips a real shipping email, that is the reason to move
classify earlier, not a guess we build now.

### Authorship

`userAsked` exists because a User-authored Routine must not be silently
rewritten. After the editor goes, every _new_ Routine is Bot-authored from a
conversation. Keep the check for records that still say `createdBy.kind ===
"user"`. Do not migrate them.

Jev already reviews `routine_manage` as a mutating call once mutation review
is enforced. Until then, the Bot creating a Routine is the same write it can
already do.

## Cuts

Each cut was its own commit. The rejector did not land in the same commit that
deleted the editor.

### Cut 1 — List and detail; delete the editor — done

Product-visible. Leaves every existing Routine runnable.

**App / document**

- Drop `editorNode`, `?edit=`, `?create=`, and `save-routine` from
  `app/routines/routines-document.ts`.
- A row opens a detail, not a form. The detail is read-only fields: name,
  prompt, trigger label, `config` only when present, last/next run, plus run
  now, run log, delete, and rotate/revoke when the Routine has a hook key.
- Pause/resume stay on the row.
- Empty list copy names the Bot as the author.

**Flutter**

- Delete `apps/native/lib/routines/editor.dart` and the create/edit routes
  (`RoutineEditorPage`, `creating`, `editing`, `onOpenEditor`, New Routine).
- Detail is host chrome over the same document, or a second projection the
  list opens. Prefer one document: list when no Routine is named, detail when
  `?routine=` is. Do not keep a form widget that writes `routine/create`.
- Keep `mintedKey` on rotate. Keep leave-confirmation only if the detail has
  something to abandon (it should not).
- `apps/native/test/routines_test.dart` loses editor cases; keep list, pause,
  delete, webhook-key, connection-source _display_.

**Agent**

- `routine_manage` copy: the Bot is the only author; write the prompt so it
  names the kind of event; `list_triggers` for slugs; `config` only for a
  coarse search the event type actually takes (Gmail `query`), never
  `labelIds` / `userId` / `interval`; one event is one firing; inbox sweeps
  are a schedule.
- Keep `userAsked`.

**Out of this cut**

- No Jev call. Events still fire as Cut 3.
- No stored-shape change in this cut. A later review accepted only `query`
  on `config`; see [architecture.md](architecture.md) §8.

### Cut 2 — Judge seam, always `is_or_might_be` — done

No product change. Proves the drain hook without spending Jev or dropping mail.

- `RoutineEventJudgeV1` in `core/contracts` (or next to the supervisor, not
  inside `TurnSupervisor`).
- Fake and unavailable adapters. Hosted adapter can wait for Cut 3.
- `settleRoutineFirings` calls the judge for a connection firing and ignores
  the verdict other than logging the seam ran.
- Unit tests: schedule/webhook/plugin firings never ask; connection firings
  ask once per fire id; a replay after eviction does not ask twice for the
  same event id.

### Cut 3 — Labeled Choice question, shadow — done

Jev runs. Drops are recorded, not enforced.

- `app/evals/routine-event.ts`: one Choice question, pinned Jev version,
  evidence builder that projects the payload.
- Labeled fixtures (shipping vs newsletter, invoice vs lunch, "Yes." /
  `Re: your order` / empty body must be `is_or_might_be`, clear newsletter
  `clearly_unrelated`).
- Runner beside `call-review-run.ts`. `bun run eval:routine-event`. Not in
  the pre-push gate. Reads `JEV_API_KEY`.
- Hosted adapter implements the judge. Shadow: classify, write a skipped
  _summary that did not happen_ only to logs / a non-user record, still
  admit the Turn.
- Calibrate. False `clearly_unrelated` on a reply fixture blocks Cut 4.

### Cut 4 — Enforce the drop — done

- `clearly_unrelated` settles `{ status: "skipped", summary }` and does not
  call `admitTurnV1`.
- Run-log row only. No inbox notification, no conversation line.
- Unavailable / timeout → admit as today (fail open). Same effect identity;
  do not classify again under a new key.
- Integration: stub Jev, three events (unrelated, related, "Yes."), assert
  Turn counts and run-log statuses.
- `routine_manage` / architecture §8: a connected-app firing may skip when
  the standalone event is clearly not the prompt.

## What we will not do

- A `match` field beside `prompt`.
- Fetching the Gmail thread, or any other app object, to help Jev.
- Passing the FrockBot conversation that created the Routine into the judge.
- Batching several messages into one Turn.
- Collecting `labelIds` / `interval` / `userId` in chrome.
- Classifying on the Composio POST, or inside `TurnSupervisor.startTurn`.
- A tap-the-Routine-to-chat gesture.
- Rewriting `createdBy` on existing User-authored Routines.
- Showing skipped-by-Jev rows in the conversation.

## Evaluation

Same rules as the call-review suite. Pin the Jev version to the fixtures.
Thresholds do not move between questions or Jev versions without a new label
pass.

Track false `clearly_unrelated` first (lost shipping confirmation), then false
`is_or_might_be` (wasted Turns), classify latency, and queue-cap skips during
a burst. Cut 4 does not land while a reply-style fixture is labeled
`clearly_unrelated`.

## Delivery sequence

1. Cut 1. Editor gone; Bots still fire every connection event. _Done._
2. Cut 2. Seam only. _Done._
3. Cut 3. Shadow Jev. Read the labels. _Done._
4. Cut 4. Enforce. _Done._

Architecture §6 and §8 are the current shape. CONTEXT records that
conversation authors a Routine and that a connection event may skip.
[ADR 0033](adr/0033-conversation-authored-routines.md) records that the
editor is not an author.
