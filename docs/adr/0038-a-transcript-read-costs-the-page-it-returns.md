---
status: accepted
---

# A transcript read costs the page it returns

ADR 0033 paged the durable Session log and put every `model/request` behind a
bounded projection plus chunked exact payloads. It also said that recovery,
compaction, audit reconstruction, model-history derivation _and client
transcript projection_ all read the exact hydrated event. Two consequences of
that last clause were not paid for at the time.

`SessionEventLog.readRange` reconstructed the whole Session and then sliced
it, so a range read cost one storage operation per retained payload chunk in
the conversation regardless of the range asked for. A twelve-request Session
with 80 KiB requests answered a one-event range with 38 storage reads, 36 of
them payload chunks belonging to Turns the caller never asked about.

The transcript then did that repeatedly. `GET /turns` walks up to 32 run-index
candidates, hydrates each one to decide whether it belongs to the conversation
being read and whether a person is allowed to see it, and discards most of
them. Filtering paid the full hydration cost of every candidate it rejected,
and every candidate it kept paid to reconstruct prompts the transcript has
never rendered.

## Considered options

- **Parallelise the candidate reads.** Rejected. It divides the latency and
  leaves the storage operations and decoded bytes exactly where they were,
  which is the part that scales with history rather than with the answer.
- **Store a durable page directory beside the index.** Rejected for now. Pages
  already carry their own `startSeq`, so a directory is a second copy of a
  fact that must then be kept consistent with the pages under repair and
  rebase. Bisecting the page keys costs `log2(pages)` reads and cannot drift.
- **Drop `model/request` from the transcript's events entirely.** Rejected.
  The run decoder checks that a hydrated journal is contiguous with its
  recorded range, and a reader that silently loses events is worse than one
  that bounds them.
- **Seek to the range, and read the transcript at display fidelity.** Chosen.

## Decision

**A range read seeks.** `readRange` bisects the page keys for the page holding
its first sequence, walks forward only while the range is unsatisfied, and
hydrates only the payloads the returned events reference. Contiguity is still
checked, now against the requested range rather than the whole log.

**The conversation surface reads at display fidelity.** `readDisplayRange`
returns the same events with one substitution: a cut `model/request` is
answered from its ADR 0033 projection — request id, provider, model, model
binding, and the excerpt of the system prompt, with empty `messages` and
`tools` — instead of joining its chunks. Every other cut event is hydrated
exactly, because the transcript renders its content. `BotDurableAuthority`
exposes this as `readStoredRunForDisplay`, and only the transcript uses it.
Recovery, supersede settlement, compaction, audit reconstruction and
model-history derivation stay on `readRange` and still receive the exact
request the model ran on. This narrows ADR 0033's "client transcript
projection reads the exact hydrated event" and changes nothing else about it.

**Filtering reads records, not journals.** `readRunHeader` returns the durable
run record with no journal behind it. Deciding whether a Turn is in the
conversation and whether it is visible needs the record alone, so a transcript
page hydrates only what it returns.

The durable layout is unchanged: same index, same pages, same payload chunks,
same run records. Nothing needs migration.

## Consequences

- A range read costs the pages covering the range. The twelve-request fixture
  above answers a one-event range in 2 storage reads and no payload reads.
- A transcript page's storage cost is proportional to the Turns it returns
  plus one small record read per candidate it steps over, instead of to every
  request the conversation has ever retained.
- There are now two fidelities of the same range, and a caller can pick the
  wrong one. The display path is named for what it is, is reachable only
  through one authority method, and is asserted against the exact path in the
  accessor's own tests.
- The exact request remains the only representation recovery and audit see, so
  ADR 0033's guarantee that a Turn is reconstructable is untouched.
