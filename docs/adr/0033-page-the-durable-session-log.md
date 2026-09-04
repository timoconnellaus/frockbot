---
status: accepted
---

# Page the durable session log

The Bot Durable Object used to store a conversation's entire `SessionEvent[]`
under one `latest-events` key and to copy a Turn's events into one `run:<id>`
record. Durable Object storage is SQLite-backed and caps one value at 2 MiB.
A long conversation therefore grew one value without bound, while a long Turn
grew another independently. Normal `model/request` events made this happen
quickly because each step records the normalized system prompt, messages, and
tool schemas: a ten-step production Turn reached requests of roughly 80 KiB
each and failed with `SQLITE_TOOBIG`. Every later persistence attempt hit the
same value, so the Bot could no longer repair itself with an ordinary Turn.

ADR 0030's conversation compaction cannot enforce a storage bound. It measures
model-message characters, not encoded event bytes, and it deliberately retains
the exact durable request that produced each model effect. Storage layout and
model context are separate limits.

## Considered options

- **Raise the compaction frequency or discard old events.** Rejected. Prompt
  compaction is not a byte bound, and deleting the exact event history breaks
  recovery, audit, and reconstruction of normalized model requests.
- **Keep only a hash and excerpt of every large event.** Rejected as the
  authority's only representation. It keeps inspection useful but cannot
  reconstruct the exact request or result used by recovery.
- **Page events, with bounded inline projections and chunked exact payloads.**
  Chosen.

## Decision

**One accessor owns all durable Session-event storage.** `SessionEventLog` is
the only module that reads, appends, rewrites, migrates, or projects the log.
It stores a small per-Session index and fixed-budget pages instead of one
conversation value. A page's encoded value may not exceed **256 KiB**. Pages
preserve the event `seq` order, and every append, rewrite, range read, and
hydration checks contiguity.

**A durable page contains a bounded projection of each event.** An ordinary
event remains inline when its encoded representation is at most **16 KiB**.
Every `model/request`, and every other event larger than that limit, is stored
as an explicit `storage: "cut"` projection carrying a `content-cut` marker,
the exact encoded byte count, and a SHA-256 digest. A model-request projection
also retains the request id, provider, model and model binding, message and
tool counts, total request bytes and request digest, plus an **8 KiB diagnostic
excerpt** split between the beginning of the system prompt and the last
message. Debug readers use these projections and never hydrate a multi-megabyte
prompt merely to truncate it again.

**The exact event remains durable in bounded content chunks.** A cut event's
canonical JSON is split into values of at most **128 KiB**, named by Session,
sequence, and chunk ordinal. Hydration joins the chunks, verifies byte count and digest, decodes
the event at the contract seam, and then returns it. Recovery, transcript
projection, compaction, audit reconstruction, and model-history derivation all
read that exact hydrated event. The cut projection is an inspection and index
representation, not a replacement authority.

**A run record references its event interval.** New `run:<id>` values keep the
command and admission identity, status, phase, failure, settlement fields,
effect admissions, response, snapshots, and `previousEventCount`. They do not
embed the Turn's event array. Instead they carry the half-open Session sequence
range `[startSeq, endSeq)`. The run decoder accepts both this shape and the
legacy embedded-event shape. Code that needs journal semantics hydrates the
range through `SessionEventLog`; client and debug projections use the bounded
page representation and event count. An incomplete range is corrupt durable
state and fails closed. When structural repair inserts closing events into the
middle of a log and resequences its suffix, the accessor rebases every compact
run range and its prior-event boundary in the same transaction as the page
rewrite.

**Migration is transparent and admission performs repair.** A legacy
`latest-events` value remains readable. On the next admission, inside the
existing log-repair transaction, the accessor reads and validates it, writes
the new pages and index, then removes the legacy value. This ordering means a
Bot whose old value is already close to 2 MiB needs no special Turn or manual
operation: the next Turn replaces the value before appending its growing log.
Legacy run records remain readable and become range-based on their next write.

**The product loop permits 64 model steps.** The prior production ceiling of
50 is raised to 64 so a 60-step Turn is a supported regression boundary. The
ceiling is still explicit and finite; storage safety no longer depends on
reaching it.

## Consequences

- No Session page, exact-event chunk, or run record grows with the whole
  conversation or Turn, so SQLite's per-value limit is no longer a Turn-length
  limit.
- Exact normalized requests and large result/message bodies remain durable and
  reconstructible, while the debug surface stays bounded and explains what was
  cut.
- Reads that need exact history perform more storage operations, and a rewrite
  may replace several pages. This is deliberate write/read amplification in
  exchange for a hard per-value bound and one enforceable storage seam.
- Rewriting a Session garbage-collects exact-payload chunks no longer
  referenced by its pages.
- Workerd tests cover migration from a roughly 1.9 MiB legacy value and a
  thirty-step Turn with 80 KiB requests. The HTTP integration suite covers a
  sixty-step tool loop with requests of at least 80 KiB and a readable terminal
  transcript.
