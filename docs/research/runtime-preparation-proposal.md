# Runtime preparation and persistent tool catalogs

Status: agreed design, recorded in the [runtime preparation plan](../plan.md#planned-reusable-runtime-preparation-and-persistent-tool-catalogs). Implementation remains deferred until the startup walkthrough is complete. The SDK reuse direction applies within the separately planned MCP work; this decision does not authorize a Bot SDK migration or a Composio transport conversion.

## Agreed direction

Keep reusable configuration, Skill metadata and tool catalogs outside the lifetime of an individual Turn. Each Turn takes a coherent set of versioned inputs and binds fresh execution state to them. Prepare independent inputs concurrently, then apply ordered registrations, hooks and journal writes deterministically.

The ordinary first-response path should require bounded first-party reads and the model connection. Fetching external tool lists, rebuilding Skill indexes and reconnecting unused integrations must not be prerequisites for answering an unrelated message.

## What Cloudflare's MCP implementation contributes

Checked against FrockBot's pinned `agents@0.23.0`, not inferred solely from current documentation:

- `MCPClientManager` belongs to the DO lifecycle and holds connections across Turns. `listTools()` reads the retained catalog; `getAITools()` reuses converted schemas while rebuilding invocation closures. [Manager source](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/mcp/client/index.ts#L389).
- Connection registration/options and resumable protocol/session metadata are persisted. The manager's tool arrays and converted-schema cache are in memory; the restore path reconnects and discovers catalogs again. Persisted protocol discovery information is distinct from FrockBot's exact tool-schema snapshot for a Turn. [Storage](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/mcp/client/storage.ts#L12), [connection discovery](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/mcp/client/connection.ts#L430).
- HTTP restoration starts connection/discovery tasks without awaiting each one. Calling `waitForConnections()` would deliberately wait for all pending connections and, without a timeout, has no imposed wait limit. [Restore and wait](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/mcp/client/index.ts#L997).
- The connection handles tool-list changes and replaces its live catalog. That is useful for refresh, but does not pin a stable schema set for a FrockBot Turn. [Change handling](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/mcp/client/connection.ts#L188).

This is relevant prior art for retaining integrations across Turns. It also leaves an application responsibility: a durable catalog available before reconnection, plus FrockBot's authority, source versions and effect guarantees. Do not make every chat await the SDK's all-connections barrier or treat an empty catalog during restoration as proof that the User has no integrations.

The package exports `agents/mcp/client`; direct installation of `MCPClientManager` on a standalone Lifecycle is explicitly experimental in the pinned source. Prefer reusing supported SDK connection/transport machinery for actual MCP rather than copying its internals, but choose its lifecycle owner separately from the chat Turn runtime. Current docs also describe durable registration and OAuth handling: [MCP client documentation](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/).

The subsequent [SDK reuse review](sdk-reuse-decision-review.md#mcp-the-managers-owner-is-the-important-constraint) makes this boundary concrete: the manager requires DO lifecycle/storage and does not persist custom transport `fetch` callbacks. A Plugin Dynamic Worker cannot directly host that manager, and initial registration alone cannot preserve a grant-aware transport through restoration. The review recommends the official protocol client/transports Cloudflare uses as the narrower library seam, unless a supported durable owner/restore adapter satisfies the existing authority boundary. Exact library selection remains part of deferred MCP implementation.

FrockBot currently uses Composio REST for connected apps. Its existing plan defers MCP as a Plugin through the `http` grant. This proposal does not reverse that decision, introduce a new Plugin grant, or convert Composio to MCP just to obtain caching. Use the same persistent catalog pattern for Composio now; assess the SDK adapter/lifecycle owner when implementing the planned MCP support. Migrating the whole Bot superclass is unnecessary for the current startup fixes.

## Ownership and data flow

| Owner                          | Reusable data                                                                                                                  | What remains specific to a Turn                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Existing User DO               | Account configuration/features/composition revisions, Connection directory, versioned connected-app catalogs, User Skill index | The authorized subset selected for a Bot and the versions it admits                                        |
| Existing Bot DO                | Bot settings/enablement revision, Bot Skill index, agreed working-context projection                                           | Run identity, cancellation, billing, effect admissions, exact catalog/Skill references and execution state |
| Existing file/artifact storage | Canonical Skill bodies and immutable Plugin artifacts                                                                          | Explicitly loaded instructions and their provenance in the Turn log                                        |

Keep account catalogs partitioned by User, Connection identity/generation and provider source. A schema cache is never evidence of permission. Account ownership, current grants and Connection state must still be checked at the operation that needs them. Removed or revoked integrations become unusable immediately, regardless of cached metadata.

### One preparation snapshot

Add a bounded account-preparation read which returns the relevant account inputs and revision references together. Read Bot-local state concurrently. Reuse those results through admission and runtime construction instead of independently rereading account configuration, features, Plugin enablement and composition.

Select Plugin Skills from the composition actually mounted, including any fallback, so instructions and available tools agree. Retain the admitted versions for recovery and handle queued Turns explicitly. A logical snapshot is not a cross-DO transaction: verify relevant revisions at admission/use and restart preparation when required to avoid mixed versions. Do not freeze revocations or copy credential leases into reusable caches.

### Skill indexes updated on writes

Parse and validate a Skill when its source is written or changed. Maintain the catalog's name, description, authority, source identity, generation/hash, reference metadata and validation outcome. Cover every write path, including workspace sync, User edits, Bot writes, deletion and Plugin enablement/composition changes. Publish a generation only with a coherent index, or explicitly mark it unavailable while rebuilding; never silently serve superseded instructions.

Startup reads the permitted metadata catalog. Explicit invocation and `skill_load` fetch the required body at its admitted version; immutable body caches are optional accelerators. Preserve reference-file authority checks, refusal behaviour and journal attribution. If a pinned version cannot be served, report that rather than substituting another version. This maintains the current progressive disclosure to the model while removing eager file reads from ordinary startup.

### Tool catalogs shared across Turns

Maintain one versioned catalog per account Connection, with compact namespace descriptions, tool metadata, exact schemas/provider versions, a content revision and refresh state. Store and retrieve it by version and namespace; ordinary startup loads a small directory and references, not every schema body. Keep existing storage/retention bounds, protecting catalog versions referenced by active Turns.

Use the existing `get_dynamic_tools` / `call_dynamic_tool` interface. Namespace browsing and indexed tool search can use the prepared catalog. Before first disclosure of a namespace's schemas, validate/select its version under the freshness policy and persist that exact version in the Turn before returning it to the model, then reuse that pin through later steps and recovery. The initial snapshot carries references to available catalog versions; a namespace missing a catalog is explicitly pending and acquires its first pin when discovery succeeds. Do not silently change schemas already disclosed in an active Turn.

Refresh on successful connect/reconnect and relevant configuration changes. For MCP, use list-change notifications plus reconciliation after reconnection; for providers without notifications, use coalesced, durably scheduled refresh. Refresh intervals and maximum permissible catalog age belong to the adapter's policy, not to a new blocking check on every greeting. Discovery failures retain the last verified version and record its age/status; if it is too old under that policy, actual schema discovery waits for a bounded refresh or reports unavailability. No unrelated chat waits for that refresh.

On a missing catalog, first-use discovery awaits only the requested Connection with a deadline. On a cold MCP restore, tool invocation similarly waits only for the needed connection to become usable. A generic SDK reconnect of several servers may proceed in the background, but must not become an all-server readiness barrier. Do not keep sockets alive solely to preserve metadata: the durable catalog must be usable after eviction.

Composio execution already sends each tool's provider version, so retain that behaviour when using cached schemas. Generic MCP does not necessarily offer version-pinned execution: before dispatch, compare the selected tool with the current discovered schema and refuse/re-disclose a changed definition rather than silently invoking a different contract. Pinning the local schema does not promise that the remote implementation cannot change.

Tool calls continue through FrockBot's current execution authority and effect ledger. SDK convenience execute closures are not a replacement for admission. Reconnecting or refreshing discovery may be retried; an action whose outcome is uncertain is not automatically repeated. Any actual MCP adapter must also retain the Bot/Session/Turn association for concurrent responses and elicitation, and avoid sharing conversation-scoped remote state merely because credentials are account-wide.

### Fresh runtime, prepared inputs

Load prepared Skill metadata, the agreed Memory core, bounded conversation context and independent catalogs concurrently within a shared limit. Keep registrations, prompt patches and journal writes in their existing order. Construct fresh Turn state, stop signals, billing and capability bindings; retain the existing immutable Plugin artifact and health caches.

Preserve prompt content and ordering for unchanged versions, and keep newly disclosed schemas/instructions near the work that requested them. This complements the prompt-cache plan and avoids increasing startup tokens by eagerly exposing full Skill bodies or all external schemas.

Voice uses the same account preparation/catalog views and its selected Bot's context. Consolidate its duplicate initial session-memory read; retain revision checks and refresh on wake, resumption or handover. This does not add connected-app schemas to Gemini's opening prompt or change its current delegation model without a separate decision.

## Implementation sequence and checks

1. Share revisioned preparation inputs and fix the current-vs-pinned Plugin Skill mismatch.
2. Maintain durable Skill metadata and move body retrieval to explicit use.
3. Introduce persistent Composio catalogs, durable refresh, and first-use schema pinning behind the current dynamic-tool interface.
4. Parallelize independent preparation, preserve ordered application, and consolidate voice's initial reads.
5. Evaluate SDK MCP integration within the separately planned MCP Plugin work; use the prepared catalog boundary rather than moving external reconnects into Bot startup.

Verify unchanged configuration avoids repeated discovery, cold activation uses durable indexes, a greeting succeeds while an unused integration is unavailable, and first-use discovery waits only for the requested integration. Cover concurrent refresh, source edits, revocation, composition fallback, queued/recovered Turns, malformed or unavailable schemas, exact-version disclosure, and crash boundaries around pinning. Preserve prompt equivalence where policy is unchanged. Catalog freshness and first-use pinning deliberately change current semantics and must have explicit acceptance cases. No latency measurement is needed for this design walkthrough.

Source retrieval used gh-axi for repository inspection; its raw-file preview truncated source, so the native GitHub CLI retrieved complete public tagged files into `/private/tmp/frockbot-sdk-mcp-*-0.23.0.ts`. No dependency changes, live MCP sessions, provider calls or product implementation were performed.
