# Bot directory and prepared runtime inputs

Read the [common rules and task order](README.md) first. Implement only the assigned S1/S4 task. The [runtime preparation design](../research/runtime-preparation-proposal.md) supplies rationale; this packet directs the implementation.

## S1: Bot directory

**Entry points:** `BotRegistrationV1` in [app/flock/shared.ts](../../app/flock/shared.ts); `mirrorAvatar`, `mirrorVoice` and registration in [app/flock/user.ts](../../app/flock/user.ts); Bot profile transactions in [app/settings/bot.ts](../../app/settings/bot.ts); User/Bot RPCs in [user-configuration.ts](../../apps/cloudflare/src/user-configuration.ts) and [bot-state.ts](../../apps/cloudflare/src/bot-state.ts); `listBots`, `botIdentity`, `buildPromptContext` and admission in [voice-assistant.ts](../../apps/cloudflare/src/voice-assistant.ts).

1. Add a current profile projection to each directory entry: name, optional description and the source Bot configuration revision. Keep creation seeds semantically separate where they are still needed for initial Bot materialization. Directory membership remains User-owned; the Bot's settings remain the profile authority.
2. Inventory both User-originated and tool-originated profile writes, including `bot/update-profile`, `bot/set-profile`, creation/import and deletion. Commit a coalesced pending profile-mirror record with the Bot settings change. The receiver applies only a newer source revision to an existing registration; it neither resurrects a deleted Bot nor lets an older retry overwrite a rename.
3. Attempt mirror delivery after commit and retain/retry failures through the existing Bot alarm owner. Seed the initial current profile during registration. A queued mirror is versioned derived state; never claim this is a cross-DO atomic update. Include its storage changes in scoped test-state cleanup.
4. Split opening-directory projection from live `list_bots` activity. Opening uses the directory already obtained by successful admission and its profile fields. Keep the selected Bot's authoritative identity read where admission/context needs it. A directory profile must not cause a live call to each other Bot.
5. Keep live activity available through explicit `list_bots`; use bounded concurrency there. Omit unknown activity from the opening projection instead of asserting every Bot is idle. Keep directory order and existing prompt formatting deterministic.

**Done when:** voice opening against many Bots calls no unrelated Bot DO; an unrelated Bot that never resolves cannot delay opening; selected-Bot identity stays correct; rename/description updates converge after mirror failure/eviction; out-of-order mirror delivery cannot revert a profile; deleted Bots stay absent. Extend Flock User/Bot tests and voice runtime tests. Do not remove useful activity from the explicit tool.

## S4a: Preparation inputs

**Entry points:** `admitRun`/execution in [app/shell/turn.ts](../../app/shell/turn.ts), `agentRuntime` in [runtime-mount.ts](../../app/shell/runtime-mount.ts), [backend-composition.ts](../../app/shell/backend-composition.ts), [UserConfiguration](../../apps/cloudflare/src/user-configuration.ts), [app/settings/bot.ts](../../app/settings/bot.ts).

Introduce one app-level prepared-input value, with ordinary functions that read and validate it. Its fields are references/data, not a mounted runtime:

```text
PreparedTurnInputs
  identity: User + Bot
  account: configuration revision + relevant settings/features
  bot: configuration revision + Plugin enablement revision
  composition: requested generation + actually mounted generation
  connections: permitted identity/generation + safe metadata/catalog refs
  skills: permitted metadata-index revisions
  context: S2 projection revision/sequence
  memory: permitted prepared-core refs (existing adapter until M3 replaces it)
```

1. Add a bounded account-preparation RPC that reads relevant account-owned records coherently on the existing User DO. Avoid serial RPCs for configuration/features/composition when one owner already holds them. Omit secrets and credential leases.
2. Read Bot-local preparation concurrently. Reuse the returned account inputs through admission and runtime construction. Pass them explicitly; do not cache a mutable `AgentRuntime` between Turns.
3. Persist the actual admitted inputs/versions needed by queued/recovered Turns in their existing snapshot. When a new version changes semantically relevant inputs before admission, retry preparation a bounded number of times, then return an explicit conflict/unavailable result. Do not spin indefinitely on a hot account. Once admitted, restore the recorded versions; live revocation still fences actual use.
4. Resolve Plugin Skill metadata from the generation that actually mounted, including fallback. A newer available artifact is not the source of instructions for an older admitted/mounted artifact.
5. Prepare independent immutable inputs concurrently using the existing concurrency limiter. Keep registration, hook application, prompt assembly and journal order deterministic. Reuse immutable artifacts already cached by the host.
6. Voice initially uses one session-Memory read shared between prompt assembly and opening. Read again when required by a new wake/handover/revision, not twice in one initial attempt. Keep long-term Memory behind an app-level reader so M3 changes its implementation, not every caller.

**Done when:** one Turn does not re-read the same account preparation solely because another feature needs it; queue/recovery uses admitted versions; current revocation is enforced; fallback composition and Skill instructions agree; two Turns have distinct mutable state; unchanged inputs produce equivalent model requests. Extend runtime, composition, queue/recovery and Skill-source tests.

## S4b: Skill indexes

**Entry points:** [catalog.ts](../../app/skills/catalog.ts), [inventory.ts](../../app/skills/inventory.ts), [agent.ts](../../app/skills/agent.ts), [write.ts](../../app/skills/write.ts), [plugin.ts](../../app/skills/plugin.ts), [Skill contracts](../../core/contracts/skills.ts), [workspace store](../../core/workspace-store/store.ts) and the User/Bot workspace generation owners.

Use a metadata index per User/Bot instruction root. An entry identifies source authority, root/path, exact generation/content hash, parsed name/description, reference-file metadata and validation/refusal result. Managed/Plugin Skills derive their metadata from the immutable artifact actually mounted. Keep source-qualified references; names alone are not identities.

1. Enumerate every mutation route: Skill tools, settings/edit UI, direct Workspace writes/deletes, Computer sync/import, generation repair, Plugin enablement and composition/fallback. Update/invalidate the index from the shared generation publication seam, not only the friendly Skill tool.
2. Parse/validate on change using the existing bounded grammar and authority predicates. Publish coherent metadata with its generation. R2 bytes and DO indexes cannot commit atomically: record pending publication/rebuild durably and mark the affected entry unavailable until bytes/generation/index agree. A failed generation record must not leave an indefinitely trusted old entry.
3. Preserve an immutable body/reference version when promising that a queued Turn can later load it; a generation label on a mutable R2 path is insufficient. Prefer content-addressed object bytes plus a version reference from the index. Write bytes before publishing the reference; clean unreferenced artifacts separately. Reads still enforce source authority.
4. Startup loads metadata only. Explicit invocation and `skill_load` fetch the admitted body/reference version. Retain refusal outcomes and attribution. Missing pinned bytes produce an explicit unavailable result; never substitute the current body silently.
5. Retain versions referenced by admitted work or store the exact invoked content in its durable snapshot. Implement one retention strategy with a tested release path; avoid an unbounded historical cache. Root deletion or grant revocation overrides a pin.
6. For incompatible disposable state, use the release cleanup/reseed path. A bounded administrative rebuild may exist, but ordinary startup must not fall back to scanning every Skill file.

**Done when:** ordinary cold startup performs no Skill body reads or directory walk; all mutation routes invalidate correctly; a body edit between queueing and execution cannot silently change instructions; removed/revoked sources cannot load; Plugin fallback selects the correct source; malformed entries are refused without breaking unrelated chat. Extend existing Skill catalog/source/reference workerd tests and workspace-generation tests at the shared seam.

## S4c: Tool catalogs

**Entry points:** [app/connect/agent.ts](../../app/connect/agent.ts), [composio.ts](../../app/connect/composio.ts), [user.ts](../../app/connect/user.ts), the existing `turnToolCatalogPin` caller in [runtime-mount.ts](../../app/shell/runtime-mount.ts), and namespace discovery/dispatch in [core/tools/tools.ts](../../core/tools/tools.ts).

Store account catalogs on the existing User DO, keyed by User, Connection ID/generation and provider source. Separate a small namespace/tool-name directory from exact schema bodies. Each immutable catalog version carries content hash, provider/tool versions, fetched time, freshness policy version and refresh status. Connection credentials are excluded.

1. On connect/reconnect or relevant configuration change, record a coalesced durable refresh job. S4c owns its integration with `UserConfiguration`'s existing alarm: commit the job and required User deadline together, drain bounded due jobs there, and preserve credential, Connection, publication and other existing deadlines. Bot/voice S3 scheduling does not supply this wakeup. Fetch schemas outside a transaction, validate bounds/shape, then publish only if the Connection generation still matches. Revocation invalidates availability even if old schemas remain for audit.
2. Runtime mounting registers compact namespaces without fetching external schemas. Extend the existing tool-registry interface with a lazy namespace resolver, rather than writing a parallel registry. Bare namespace listing must not run resolvers. Pattern search uses durable metadata to choose namespaces; any complete schema returned still requires the next step's pin.
3. At first schema disclosure, select a usable catalog for only that Connection and persist the exact namespace catalog in the Turn using the existing pinning mechanism. Keeping a bounded exact copy with that Turn is preferable to adding cross-DO reference-count transactions. Persist before returning schemas to the model. Recovery and later steps read the pin, not the newest account catalog.
4. Discovery and dispatch share that resolver. A call cannot bypass schema validation/pinning merely because it names a tool directly. Preserve descriptor matching and existing `get_dynamic_tools`/`call_dynamic_tool` behavior. A multi-namespace search resolves only matched namespaces within existing result bounds.
5. Missing/stale catalog: coalesce bounded first-use discovery for the requested Connection, then return tools or an explicit unavailable outcome. Other namespaces/chat remain usable. A failed background refresh records failure/age without discarding a still-valid last-known version.
6. Engineering defaults for a new freshness policy: refresh after 1 hour, require a successful refresh before first disclosure after 24 hours, and bound first-use discovery to 5 seconds. Put these in named adapter policy constants with injected time. They are implementation starting values, not performance promises; adjust against provider constraints and record any change. Reconnect/generation changes invalidate immediately. Preserve existing tighter size/rate limits.
7. Dispatch checks current Connection/grants and retains occurrence/effect fencing. Continue passing Composio's tool version. Schema pinning never authorizes an uncertain external write to be repeated. An already disclosed catalog remains pinned even as another Turn refreshes the account catalog; if its execution contract is no longer usable, return an explicit stale-contract result.

**Done when:** a greeting needs no external schema request; cold activation uses the durable catalog; two concurrent first users share discovery; each Turn pins before disclosure; refresh cannot change an active Turn's schema; revocation blocks dispatch; eviction around refresh/pinning loses no obligation; malformed/oversize catalogs fail explicitly. Race catalog refresh deadlines with existing User credential/publication recovery and prove all progress. Verify catalog retention stays bounded without deleting active Turn copies. Composio remains REST; no MCP manager, transport rewrite or new grant is introduced.
