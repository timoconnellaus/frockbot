# Research: zerobsai memory, FUSE/R2, and the Worker Loader sandbox

Read-only study of `~/repos/zerobsai` for FrockBot. Every claim cites `<sha>:<path>:<line>` — verify with
`git show <sha>:<path>`. "Observed" = read in the code. "Inferred" = my reading, flagged inline.

## Summary

zerobsai ships **two independent persistence systems that were never joined**. Memory is a Worker-side
store: markdown files in an R2 bucket (`MEMORY_FILES`), a JSON sidecar per file holding chunk hashes and
vector ids, and a Vectorize index (`MEMORY_INDEX`) as the derived search layer — no disk, no FUSE, no DO
SQLite. Separately, the sandbox container FUSE-mounts a _different_ R2 bucket (`zerobs-sandbox-files`) at
`/workspace` using **tigrisfs**, and R2 event notifications feed a queue that bumps a per-site Durable
Object version. Tim's idea — memory files on the sprite's disk _and_ in R2 via FUSE — is the merge of these
two, which zerobsai never performed. Memory peaked at `dae80298` (2026-05-23): chat RAG + pinned
preferences + voice pre-setup recall + post-call summariser, all over one namespace. Nothing regressed
functionally; the whole `apps/web` product was deleted wholesale on 2026-08-25 (`fea4c259`).

## Findings

1. **Memory is markdown-in-R2 with a JSON sidecar; Vectorize is purely derived (positive, high).** R2 holds
   `${ns}/files/${path}` (markdown) and `${ns}/meta/${path}.json` = `{ hashes, vectorIds }`
   (`dae80298:apps/web/src/lib/chat/memory/storage.ts:3-20`). Namespace is `user:${userId}`
   (`dae80298:apps/web/src/lib/chat/memory/types.ts:5-9`). Vector ids are
   `` `${ns}/${path}:${startLine}` `` (`.../indexer.ts:10-12`), so the index can always be rebuilt from the
   files. Canonical = R2 markdown; derived = sidecar hashes + Vectorize vectors. For FrockBot: keep the
   Bot's memory canonical as plain files, and treat every index as a droppable, rebuildable projection.

2. **Incremental re-index is hash-diffed per chunk, and self-heals stale vectors (positive, high).**
   `indexDocument` chunks markdown on paragraph boundaries with overlap (1600/320 chars,
   `.../chunker.ts:1-2,48-86`), compares each chunk's SHA-256 against the sidecar, embeds only changed
   chunks, then deletes vector ids present in the old sidecar but not the new set
   (`.../indexer.ts:28-61`). Embeddings are Workers AI `@cf/baai/bge-base-en-v1.5`, 768-dim, batched at 100
   (`.../types.ts:26-27`, `.../embeddings.ts:11-23`). For FrockBot: copy the sidecar-hash pattern verbatim;
   it makes re-indexing after a FUSE write cheap and idempotent.

3. **Search degrades to keyword scan rather than failing (positive, medium).** `searchMemory` queries
   Vectorize (`topK = min(maxResults*3, 20)`), dedupes to best-chunk-per-path, and re-reads the snippet
   from R2 by line range; on any vector error it returns `null` and the caller falls back to a full listing
   - case-insensitive line scan (`dae80298:.../chat/memory/searcher.ts:25-44,78-114,141-142`). For
     FrockBot: a memory tool that can't reach the index must still answer from files.

4. **Three distinct injection paths, not one recall tool (positive, high).** (a) _Pinned_ — every file at
   `preferences.md` or under `preferences/` is concatenated into the system prompt each turn, capped at
   2048 bytes with an explicit truncation note (`.../pinned.ts:4-6,12-14,20-46`). (b) _Per-turn RAG_ —
   `loadTurnMemory` runs pinned + a 4-result search against the latest user text, drops anything already
   pinned, and never throws (`dae80298:apps/web/src/lib/server/org-chat-agent.ts:73-115`); both land as
   `## Pinned preferences` / `## Possibly relevant memories` blocks
   (`.../chat/system-prompt.ts:132-138`). (c) _Tools_ — `memory_search/get/write/delete`
   (`.../chat/capabilities/memory.ts:36-112`). The prompt explicitly tells the model the blocks are already
   loaded and not to re-search them (`.../system-prompt.ts:120-130`). For FrockBot: pinned-always +
   retrieved-per-turn + on-demand tool is the right three-way split; state in the prompt which is which.

5. **Voice adds a post-call summariser writing back into the same namespace (positive, high).** On call end
   the transcript is coalesced per speaker turn, summarised by a prompt that mandates verbatim preservation
   of IDs/dates/URLs, and written to `voice-sessions/<ISO>.md`, then indexed
   (`dae80298:apps/web/src/lib/voice-call/voice-session-memory.ts:88-117,123-158,163-206`). Pre-setup
   recall reads the 2 most recent session files by _path sort_, no vector query, 6 KB budget
   (`ibid.:31-86`). It is `waitUntil`-safe and never throws. For FrockBot: date-sorted paths are a
   zero-index recency channel — cheap and worth having alongside embeddings.

6. **The FUSE layer is tigrisfs, and it mounts a different bucket than memory (risk, high).**
   `tigrisfs` is installed from GitHub releases (`dae80298:mcp-sandbox-container/Dockerfile:89-95`) and
   `startup.sh` mounts `"${R2_BUCKET_NAME}:${AGENT_ID}"` at `/workspace` against
   `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` with `-o allow_other`, as PID 1's child before
   dropping to the `sandbox` uid (`dae80298:mcp-sandbox-container/startup.sh:4-56,217-218`). That bucket is
   `zerobs-sandbox-files`; memory lives in `zerobs-memory-files` reached only through the Worker binding
   (`dae80298:apps/web/wrangler.jsonc:90-92`). **Nothing in zerobsai puts memory files on the FUSE mount** —
   `git grep` finds no such path. For FrockBot: the union Tim describes is new work, not a port.

7. **Writes reach R2 as the _only_ write path; the DO learns via an R2 event queue (positive, high).** Agent
   file tools POST to the container, which writes to `/workspace` and therefore to R2 — the Worker never
   calls `SANDBOX_FILES.put` (`576c98fe:apps/web/src/lib/chat/tools/write-file.ts:27-34`;
   `b611fae0` commit message). R2 object-create/delete notifications land on the `vibe-r2-sync` queue; the
   consumer parses `<userId>/apps/<slug>/...`, coalesces a burst into one target per site, and calls
   `bumpVersion()` on `VibeSiteDO` (`576c98fe:apps/web/src/lib/vibe-site/r2-sync-queue.ts:1-11,24-77`). The
   bucket-side rule is configured once by CLI; the prefix predicate lives in the consumer because wrangler
   can't express it (`dae80298:apps/web/wrangler.jsonc:111-120`). For FrockBot: R2 notifications are the
   supported way to make a DO aware of out-of-band disk writes — but see finding 8.

8. **There is no conflict resolution and no read-your-write guarantee (risk, high).** The DO's cache key is
   a version counter; a bump means "re-snapshot R2 next request", and the skill tells users edits appear
   "usually <1s" after refresh (`fe1bfd69:apps/web/src/lib/vibe-site/do.ts:53-70`;
   `dae80298:apps/web/src/skills/vibe-coding.md:81`). Last-writer-wins with no fencing, no vector clock, no
   compare-and-set. Self-writes are kept out of the loop only by _prefix segregation_ — the bundle cache
   lives at `<userId>/bundles/...`, deliberately outside the watched `/apps/` prefix
   (`fe1bfd69:.../do.ts:23-26`). For FrockBot: if memory is written from both the DO and the sprite, you
   must design the fencing zerobsai never needed; at minimum, segregate agent-written from
   host-written prefixes the same way.

9. **FUSE in `wrangler dev` needs a Docker socket MITM (positive, medium).** CF Containers grants
   CAP_SYS_ADMIN in prod; `wrangler dev` does not, so `/dev/fuse` can't open and `/workspace` silently
   becomes tmpfs (`dae80298:apps/web/CLAUDE.md:192-208`). `scripts/docker-fuse-proxy.mjs` is a Unix-socket
   forwarder that intercepts `POST /containers/create`, splices `SYS_ADMIN` into `HostConfig.CapAdd` and a
   `/dev/fuse` device into `HostConfig.Devices`, rewrites Content-Length, and forwards
   (`dae80298:scripts/docker-fuse-proxy.mjs:82-133`); dev runs wrangler with
   `DOCKER_HOST=unix:///tmp/docker-fuse-proxy.sock` (`ibid.:17-19`). For FrockBot: budget for this; it is a
   hard prerequisite for testing any FUSE design locally.

10. **Silent-failure surfacing is the hard-won lesson (positive, critical).** `startup.sh` writes
    `mounted` / `no-r2-creds` / `mount-failed` to `/var/run/zerobsai/fuse-status`, which the CLI reads and
    prepends as `[warn] /workspace is ephemeral: ...` so the model itself knows persistence is off
    (`dae80298:mcp-sandbox-container/startup.sh:21-58`; `b611fae0` commit message). For FrockBot: make
    "memory is not durable right now" a value the agent can read, not a log line nobody sees.

11. **FUSE is too slow for build-shaped I/O (risk, high).** Both bundlers deliberately copy out of the FUSE
    mount: `bun install` runs in a container-local temp dir "rather than the FUSE-mounted R2 prefix"
    (`fe1bfd69:mcp-sandbox-container/vibe-bundler.ts:58-60`), and the zbsai path rsyncs
    `/workspace/apps/<slug>` into `/var/cache/vibe/<slug>` before building
    (`65d9c25b:mcp-sandbox-container/zbsai/src/vibe.ts:7-16,196-205`). For FrockBot: memory files (small,
    markdown) are a fine FUSE workload; anything `node_modules`-shaped is not.

12. **Worker Loader sandbox: code in D1, one isolate per (owner, tool, version) (positive, high).**
    A user tool is a D1 row — `code` TEXT plus a monotonic `version` per `(userId, name)`
    (`dae80298:apps/web/migrations/0058_user_tools.sql:15-26`). At run time `AgentRunnerDO` loads the
    selected names (missing rows are skipped so a deleted tool doesn't break an installed agent,
    `dae80298:apps/web/src/lib/server/user-tools.ts:44-79`) and builds an `EngineTool` per def. The loader
    name is `` `agent-user-tool::${ownerKey}::${def.name}::v${version}` `` — bumping the version evicts the
    stale isolate (`b55750b6:apps/web/src/lib/agent-runtime/sandbox/loader.ts:37,43-51`). The module map is
    exactly two entries: a generated `wrapper.js` and the user's `user-tool.js`
    (`ibid.:46-50`). For FrockBot: this is the closest prior art to the self-modification plan — versioned
    source rows, immutable loader ids, no bundling step.

13. **Capability brokering is done right; egress control is not (risk, critical).** The wrapper is a
    `WorkerEntrypoint` whose `execute(args, broker)` builds a two-verb `ctx` (`generateText`, `log`) from a
    remote `RpcTarget` stub, so user code never touches `env` or the provider key
    (`b55750b6:apps/web/src/lib/agent-runtime/sandbox/wrapper.ts:11-22`,
    `.../broker-target.ts:15-41`). `generateText` charges a shared `RunBudget` before every call and adds
    token usage after (`.../broker-target.ts:26-37`), and the budget is shared with the host loop so
    sandbox spend counts against the same caps
    (`dae80298:apps/web/src/lib/agent-runner/do.ts:247-273`). **But `globalOutbound: null` is never set** —
    the only occurrences repo-wide are in generated `worker-configuration.d.ts`. User tool code can `fetch`
    the internet freely. Input validation is also absent: the schema column was deferred and args ride as
    `z.object({}).passthrough()` (`0058_user_tools.sql:11-14`,
    `dae80298:apps/web/src/lib/server/user-tools.ts:41-42`). For FrockBot: copy the broker, and close both
    holes on day one.

14. **Failure handling wraps but does not quarantine (risk, medium).** A throw inside the isolate is caught
    and re-thrown as `user tool "<name>" failed: <msg>`
    (`b55750b6:.../sandbox/loader.ts:54-58`); the vibe DO similarly keeps `loader.get` inside the try so a
    module-scope throw surfaces as "Worker error" not an opaque 500
    (`fe1bfd69:apps/web/src/lib/vibe-site/do.ts:264-282`). There is no retry policy, circuit breaker, or
    auto-disable of a repeatedly failing tool. For FrockBot: add quarantine-after-N-failures.

15. **The 128 MB lesson: never bundle inside a Durable Object (risk, critical).** `VibeSiteDO` ran esbuild
    via `@cloudflare/worker-bundler` in-process; the DO's 128 MB cap OOMed the isolate on every production
    request, surfacing as an opaque "Dispatch failed", and **it passed local dev because `wrangler dev`
    does not enforce the cap** (`fe1bfd69` commit message). The fix moved bundling to the container's
    `/vibe/bundle` route (`fe1bfd69:mcp-sandbox-container/vibe-bundler.ts:1-9`), leaving the DO to own only
    version counters, the R2 bundle cache, and Worker Loader dispatch
    (`fe1bfd69:apps/web/src/lib/vibe-site/do.ts:53-70`). For FrockBot: keep the Bot DO to orchestration and
    counters; anything memory-hungry (embedding batches, bundling, large file reads) goes to a sprite or a
    Worker, and must be load-tested against the real cap, not dev.

16. **Restic gives the container a cold-restart cache, and taught a lifecycle lesson (positive, medium).**
    `/var/cache/vibe/<slug>` is snapshotted to R2 with restic, keyed by a per-(user, site) password derived
    as an HMAC of `RESTIC_MASTER_KEY` read from a 0400 file
    (`dae80298:mcp-sandbox-container/startup.sh:102-120`; `65d9c25b:.../zbsai/src/vibe.ts:11-16,32,207-214`).
    The original fire-and-forget
    `restic backup` was killed when the CLI process exited, so snapshots never landed; it was made awaited,
    and snapshot health became an explicit stdout line (`ok`/`disabled`/`FAILED`) plus JSON fields, because
    the agent was reading exit 0 as success (`65d9c25b` commit message, and `.../vibe.ts:151-164`). For
    FrockBot: any background durability step spawned from a short-lived process must be awaited, and its
    outcome must be visible to the model.

## Memory layout (as built)

R2 bucket `zerobs-memory-files`, binding `MEMORY_FILES` (`dae80298:apps/web/wrangler.jsonc:90-92`):

```
user:<userId>/files/preferences.md              ← pinned into every turn
user:<userId>/files/preferences/<topic>.md      ← also pinned
user:<userId>/files/voice-sessions/<ISO>.md     ← post-call summaries, sorts by date
user:<userId>/files/<free-form>.md              ← e.g. standup.md, clients/acme.md
user:<userId>/meta/<same path>.json             ← { hashes: {startLine: sha256}, vectorIds: [] }
```

Vectorize index `zerobs-memory`, binding `MEMORY_INDEX`, namespace = `user:<userId>`, vector id
`user:<userId>/<path>:<startLine>`, metadata `{ path, namespace, startLine, endLine, hash }`
(`dae80298:.../memory/indexer.ts:10-12,39-52`; `wrangler.jsonc:104-110`). Paths are constrained to
`[A-Za-z0-9._/-]`, no leading `/`, no `..` (`dae80298:.../chat/capabilities/memory.ts:11-16`). No DO SQLite
and no container disk are involved anywhere in this path.

## FUSE/R2 flow (as built)

Separate system, bucket `zerobs-sandbox-files`:

```
chat tool (write_file/edit_file/run_command)
  → POST container /write            576c98fe:apps/web/src/lib/chat/tools/write-file.ts:27-34
  → node writes /workspace/apps/<slug>/...
  → tigrisfs (FUSE, started by startup.sh as root, uid-mapped to `sandbox`, -o allow_other)
       dae80298:mcp-sandbox-container/startup.sh:36-40
  → R2 PUT under <AGENT_ID>/apps/<slug>/...
  → R2 event notification (object-create | object-delete)
  → queue `vibe-r2-sync`             dae80298:apps/web/wrangler.jsonc:111-120
  → handleVibeR2Queue: match <userId>/apps/<slug>/, skip node_modules/.git,
    coalesce per site, VibeSiteDO.bumpVersion()
       576c98fe:apps/web/src/lib/vibe-site/r2-sync-queue.ts:24-77
  → next /__vibe/<slug>/ request: cache miss → POST container /vibe/bundle
    → cache bundle in R2 at <userId>/bundles/<slug>/<mode>.json (outside the watched prefix)
    → LOADER.get(`${doName}::${mode}::v${version}`) → dispatch
       fe1bfd69:apps/web/src/lib/vibe-site/do.ts:23-26,53-70,250-282
```

Consistency: eventual, last-writer-wins, no fencing (finding 8). Symlink escape out of `/workspace` is
blocked by a realpath re-assert on every container file route
(`dae80298:mcp-sandbox-container/helpers.ts:79-95`). Local dev requires the Docker socket proxy
(finding 9).

## Recommended FrockBot shape

1. **Canonical memory = markdown files in R2 under a bot-scoped prefix.** Adopt zerobsai's
   `files/` + `meta/` split verbatim. Everything else — embeddings, keyword indexes, DO SQLite caches — is
   derived and rebuildable from those files.
2. **Mount that same prefix into the sprite with tigrisfs at `/memory`.** This is the piece zerobsai never
   built; the mechanics (finding 6) and the dev proxy (finding 9) port directly. Memory-sized files are a
   good FUSE workload; keep build-shaped I/O off it (finding 11).
3. **Keep the agent loop in the Bot DO reading R2 directly through the binding** — no sprite needed to read
   memory. zerobsai's Worker-side `MemoryStorage` already proves that path works without a container.
4. **Make the sprite's disk writes visible via R2 event notifications → queue → DO.** Reuse the coalescing
   consumer shape. On a bump, re-index the changed paths using the sidecar hash diff (finding 2).
5. **Segregate write ownership by prefix** so DO-authored and sprite-authored files can't feed each other's
   change events, exactly as the bundle cache sits outside `/apps/` (finding 8). Where both must write the
   same file, add an explicit fence — zerobsai has none to copy.
6. **Three injection channels**: pinned files (always, byte-capped), per-turn retrieval (deduped against
   pinned), explicit tools. Tell the model which content is already loaded (finding 4).
7. **Bot-authored code: version rows + immutable loader ids + a narrow RpcTarget broker**, plus the two
   things zerobsai skipped — `globalOutbound: null` and a real per-tool input schema (findings 12-13).
8. **Surface durability state as data the agent can read** (`fuse-status` equivalent), and await every
   background durability step (findings 10, 16).
9. **Nothing memory-hungry in the DO.** Embedding batches and any bulk file work belong in the sprite or a
   Worker; verify against the real 128 MB cap, since dev won't enforce it (finding 15).

## Sources

- `7f333d09` / `50a0c385` / `c48ec1fd` (2026-05-19) — memory subsystem; pinned preferences + per-turn RAG.
- `65d9c25b` (2026-05-19) + `b611fae0` — restic snapshot lifecycle fix; `fuse-status` flag file.
- `eb342cab` / `576c98fe` / `18900ffe` / `fe1bfd69` / `4202c118` (2026-05-20) — docker-fuse-proxy;
  `r2-sync-queue.ts`; R2 bundle cache; bundling moved out of the 128 MB DO; one namespace per user.
- `b55750b6` / `dea94666` / `e1e21d34` / `1d5bfa46` / `4388af80` (2026-05-21) — Worker Loader sandbox,
  agent engine, host capability adapters, `user_tool` table.
- `dae80298` (2026-05-23) — voice cross-session memory; **the high-water mark, and the read-point for most
  citations above**.
- `fea4c259` (2026-08-25) — `apps/web` deleted entirely (1333 files); none of the above exists at HEAD.

## Gaps and residual risks

- **Memory on FUSE was never built.** Findings 1-5 describe a Worker-binding store; findings 6-11 describe a
  container mount for site source. Any claim that zerobsai "stores memory on the sprite's disk" is false.
  The merge is new design work.
- **No fencing, no conflict resolution, no compare-and-set anywhere in the R2 path.** zerobsai avoided the
  problem via single-writer + prefix segregation. FrockBot's DO-plus-sprite model has two writers and cannot.
- **tigrisfs consistency, caching, and write-flush semantics are not documented in this repo.** The only
  evidence is that it works for the site workload and is avoided for `node_modules`. Read tigrisfs's own
  docs before relying on read-your-write or `fsync` behaviour.
- **`globalOutbound` is never set** — the sandbox's egress story is unproven. Treat finding 13 as a design
  hole to close, not a pattern to copy.
- **openspec has no memory or sandbox specification.** Clean-slated at `2c99b6d5` (2026-06-01), empty at
  HEAD; the specs at `dae80298` cover auth, surveys, and marketing only. The code and commit messages are
  the only spec for memory.
- **Vectorize rebuild has no driver.** `indexDocument` is only called on write. If the index is lost, no
  code walks `files/` to rebuild it. FrockBot needs that job.
