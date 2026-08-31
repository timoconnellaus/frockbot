# Research: DeepSeek Harness provider connections as a north-star

## Summary

At current `master` (`cd5ef8148158c3a752a658978873241fdf8e2bbc`), DeepSeek Harness does **not** have a generic domain object named `Connection`. Its operative vocabulary is **provider route**, **provider profile**, **configurable provider**, **settings namespace**, **credential reference**, and **credential record**. A provider route is simultaneously the request-routing key, the profile-map key, a durable session identity, and often the credential-address suffix.

FrockBot should copy Harness's strongest boundaries—settings contain references rather than secret values, provider-specific translation stays behind a neutral LLM interface, credentials/configuration resolve per operation, in-flight requests capture an immutable generation, and streaming is normalized into a provider-neutral chunk protocol—but should **not** copy route identity as connection identity. FrockBot's separate opaque Connection ID, editable label, and Bot binding of `(connectionId, modelId)` are improvements for multi-account use. The proposal needs revision around credentialless authentication vocabulary, catalog refresh durability, and explicit revoke/delete semantics.

> **Evidence baseline.** All source links below are first-party `deepseek-ai/deepseek-harness` permalinks at commit [`cd5ef814`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc). No third-party implementation or commentary is used.

## Findings

### 1. There is no generic “Connection” entity; authoring creates provider profiles/routes

Harness authors a provider by writing a profile into the `llm-pi-ai` settings namespace under `providers.<route>`. The dict key **is** the provider route; the profile carries optional `displayName`, `apiKeyEnv`, endpoint, protocol, model catalog/overrides, transport, and policy fields. Installed pi-ai routes inherit endpoint/protocol/models; unknown routes must declare enough to build a provider. A bare plugin with `{ providers: {} }` is valid and dormant. [`packages/llm/llm-pi-ai/src/config.ts`, profile and `Config`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/config.ts#L52-L181) [`resolveProfiles`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/config.ts#L290-L395)

The web UI calls these items providers. A custom provider requires a permanent lowercase Provider ID plus endpoint, protocol, credential, and at least one model. The ID cannot be renamed because requests, sessions, defaults, settings, and credential references use it; only `displayName` is editable. [`docs/user/guide/providers.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/guide/providers.md#L17-L35) [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L31-L49)

The configurable-provider directory is only an addressable UI/runtime directory: `{provider, displayName, settingsNs, settingsPath, declared?}`. It points a surface to the profile in settings; it is not a durable Connection record. [`packages/llm/llm/src/types.ts`, `LlmConfigurableProvider`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/types.ts#L144-L178) [`packages/llm/llm-pi-ai/src/index.ts`, `directoryEntries`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L74-L110)

**Implication for FrockBot:** keep `Connection` as a real backend-owned object with an opaque ID. Do not make a package/provider slug perform identity, routing, presentation, settings-path, and credential-address duties simultaneously.

### 2. Secrets are separate from settings, and the browser gets write-only views

Harness has two credential address spaces:

- A `CredentialRef` is an environment-variable-shaped name such as `DEEPSEEK_API_KEY`. Settings and composition carry this reference; `resolve()` returns the value to backend consumers, while `describe()` returns only `{configured, source?, writable}`. `set` and `unset` are the write paths. Consumers must resolve once per operation and must not cache across operations. [`packages/credentials/credentials/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/index.ts#L1-L20) [`CredentialProvider` reference methods](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/index.ts#L127-L201)
- A `CredentialKey` is `<plugin-scope>/<plugin-owned-id>` and addresses a durable tagged record: `api-key` (key and/or provider environment) or opaque `grant` payload. Record mutation is serialized read-modify-write so token refresh can rotate safely. [`packages/credentials/credentials/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/types.ts#L14-L64) [`CredentialProvider` record methods](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/index.ts#L203-L282)

The local provider stores both spaces in versioned `$DSH_HOME/.credentials.yaml`, enforces owner-only permissions on POSIX, writes atomically under a cross-process lock, watches external changes, and keeps the last good snapshot if a hot reload becomes invalid. Its precedence is process environment (read-only) over managed file over project/user `.env`; writes reject when the process environment would shadow them. [`packages/credentials/credentials-local/src/index.ts`, storage model`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials-local/src/index.ts#L1-L42) [`permissions and document layout`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials-local/src/index.ts#L86-L184) [`resolution precedence and writes`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials-local/src/index.ts#L483-L566)

The Models page never receives a stored key. A typed key is sent through `credentials.set`; settings only retain `apiKeyEnv`. Settings descriptors are redacted, and edits use path mutations so a client cannot accidentally overwrite a secret it never received. [`docs/user/guide/providers.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/guide/providers.md#L5-L15) [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L25-L36) [`docs/subsystems/settings.md`, redacted descriptors](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/settings.md#settingsdescriptor-and-secret-redaction)

### 3. Settings, secrets, and composition are three distinct concerns

A plugin exports a Schemastery `Config` used to validate its Cordis composition entry. For user-editable state, the plugin registers the same schema under a settings namespace; resolution layers schema defaults, then composition `base`, then the user section. The profile settings shape therefore mirrors plugin config, but secret values remain behind `ctx.credentials`. [`packages/llm/llm-pi-ai/src/config.ts`, runtime schema](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/config.ts#L181-L288) [`packages/llm/llm-pi-ai/src/index.ts`, `installSettingsSection`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L246-L286) [`docs/cookbook/adding-a-settings-card.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cookbook/adding-a-settings-card.md#L7-L53)

A settings descriptor carries the serialized schema, effective value, composition base, raw user layer, revision, application timing, and redacted secret slots. Revisions fence concurrent writes. [`packages/settings/settings/src/index.ts`, descriptor contract](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/settings/settings/src/index.ts#L84-L145) [`docs/subsystems/settings.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/subsystems/settings.md#settingsdescriptor-and-secret-redaction)

**Documentation defect (moderate):** the current adapter cookbook still tells authors to place secret-bearing env fallbacks in Cordis `Config` via `!!js process.env.MY_KEY`, while current production adapters and the credentials subsystem require references in config and values behind `ctx.credentials`. [`docs/cookbook/adding-an-llm-adapter.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cookbook/adding-an-llm-adapter.md#L12-L31) This cookbook should not be treated as the north-star credential design.

### 4. Multiple routes exist, but “multiple accounts per provider” is only partially supported

One `llm-pi-ai` plugin instance owns any number of route-keyed profiles, and one adapter instance registers all configured routes. Different routes can point at different endpoints and references, so multiple API-key-backed accounts can be represented by distinct route IDs (including hand-declared aliases with explicit protocol/catalog). [`packages/llm/llm-pi-ai/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L1-L49) [`registerAdapter` route set](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L217-L245)

This is not a generic multi-account abstraction:

- Installed-catalog inheritance is keyed by the canonical route, so an alias generally becomes a hand-declared route.
- The direct DeepSeek adapter owns one fixed `deepseek-official` route/profile.
- pi-ai sign-in flows are registered once per installed provider ID, and credential records are keyed `llm-pi-ai/<provider-id>`; therefore the shipped OAuth/native-login path has one stored account per provider ID, not N independently named accounts. [`packages/llm/llm-pi-ai/src/login.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/login.ts#L105-L164) [`packages/llm/llm-pi-ai/src/auth.ts`, record address](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/auth.ts#L22-L46)

Harness state is scoped to a local Harness home/composition, not a multi-tenant cloud account model. FrockBot's explicit account-scoped Connection records and “multiple Connections per Package” are therefore deliberate extensions, not direct copies.

### 5. Catalogs are advisory; current “Fetch available models” is not refresh or cache

Harness has three catalog behaviors:

1. Installed pi-ai provider/model metadata ships with the dependency and is used as defaults.
2. Configured `models` replaces that installed route catalog; `modelOverrides` changes selected installed entries.
3. For an unknown/custom route, **Fetch available models** probes OpenAI-compatible `GET /models` with draft/stored credentials and returns candidates for user selection.

Critically, source comments say neither discovery path is a refresh and nothing is stored by discovery itself; `settings.yaml` alone decides what the route serves. Installed routes short-circuit to the installed catalog without network I/O. Only OpenAI-compatible protocols are probed. [`packages/llm/llm-pi-ai/src/discovery.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/discovery.ts#L1-L28) [`discoverModels`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/discovery.ts#L184-L257) [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L42-L49)

`LlmAdapter.listModels()` is explicitly advisory, and absence from its result must not by itself reject routing; exact model resolution is a separate call. [`packages/llm/llm/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts#L227-L264) [`packages/llm/llm/src/index.ts`, validation/listing`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts#L645-L696)

There is no durable normalized catalog cache, refresh timestamp/error state, automatic refresh, or stale-catalog retention contract. FrockBot's proposed cached dynamic normalized catalogs and stale retention are more capable, but must define who owns refresh intent/results, normalization/versioning, and what “stale but usable” means.

### 6. Adapter registration is route-based; request resolution captures one immutable generation

`ctx.llm.registerAdapter(routes, adapter)` gives each route exactly one adapter owner. Route replacement validates the complete candidate set and swaps atomically, leaving the previous registration serving on conflict. The pi-ai plugin similarly atomically replaces its configurable-provider directory. [`packages/llm/llm/src/index.ts`, registration handle](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts#L284-L334) [`packages/llm/llm-pi-ai/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L157-L245)

A request contains `provider` and `model`. The runtime uses the provider route to select the adapter; `prepareCall()` binds exact-model metadata, retry policy, and one adapter generation to a one-shot dispatch. The pi-ai adapter captures an immutable profile/model collection before its first await, resolves the named credential once for that stream, and lets an in-flight stream finish under that snapshot while the next request sees changes. [`packages/llm/llm/src/types.ts`, `GenerateOptions`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/types.ts#L295-L339) [`packages/llm/llm/src/index.ts`, `prepareCall`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts#L844-L928) [`packages/llm/llm-pi-ai/src/adapter.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/adapter.ts#L1-L27) [`stream snapshot and key resolution`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/adapter.ts#L310-L402)

This is the strongest Harness pattern for FrockBot to retain: resolve `(Connection, model, credential)` once at durable request admission/dispatch, then keep that immutable generation for the in-flight call.

### 7. Plugin metadata and schemas assist configuration, but do not generate the Models UI

Cordis plugin entry config is validated by an exported Schemastery `Config`; a package can expose a browser half via `./client` and `dsh.client` metadata. Settings registration serializes Schemastery to the browser, where `ctx.settingsSchema` rehydrates it for synchronous validation/path editing. [`docs/cookbook/adding-a-settings-card.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cookbook/adding-a-settings-card.md#L7-L53) [`packaging metadata`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cookbook/adding-a-settings-card.md#L89-L118) [`packages/client/ui-settings/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings/README.md#L48-L67)

However, Models is a hand-written, curated UI plugin, not a generated form. It explicitly joins provider directory + redacted settings descriptor + credential descriptions, exposes only curated fields, and leaves advanced schema fields in `settings.yaml`. Its package manifest declares web-client injection dependencies, not a generic Connection contribution or connection schema. [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L9-L17) [`Known Limitations`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L122-L137) [`packages/client/ui-settings-models/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/package.json#L1-L47) [`src/client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/src/client/index.ts#L45-L101)

**Implication:** FrockBot should use package-declared schemas for decoding, validation, migration, and standard fields, but should not assume arbitrary schemas produce acceptable product UI. Permit a Package-owned hosted-client contribution for bespoke authorization/settings UX while retaining backend authority.

### 8. Credentialless profiles are supported, but “none” conflates distinct cases

A pi-ai profile with no `apiKeyEnv` passes `undefined` to pi-ai and deliberately permits provider-native authentication/discovery. The Models page saves a blank-key new profile without a credential reference, preserving Bedrock chains, Vertex ADC, and similar native authentication. [`packages/llm/llm-pi-ai/src/index.ts`, `resolveApiKey`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts#L126-L156) [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md#L25-L36)

An `api-key` credential record may also contain neither a key nor env fields, meaning the owner has confirmed ambient authentication; record presence is configured state. [`packages/credentials/credentials/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/types.ts#L31-L47)

This supports requests with no stored secret, but it is not equivalent to one authorization kind `none`: a public unauthenticated endpoint, AWS/ADC ambient credentials, and a provider-managed OAuth grant have different lifecycle, authority, and observability. FrockBot should retain `none` for truly credentialless providers and add a distinct package/provider-managed or ambient/native authorization kind.

### 9. Rotation is live and safe; deletion is cautious; upstream revocation is not a generic contract

For reference keys, replacing the stored value rotates in place; the next operation sees it because adapters resolve per request. Environment-supplied keys are intentionally read-only and cannot be shadow-rotated. For grant records, `modifyRecord` holds a serialized read-modify-write boundary across refresh, and pi-ai's credential-store adapter lets the library own OAuth refresh/rotation. [`packages/credentials/credentials/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/README.md#L70-L104) [`packages/llm/llm-pi-ai/src/auth.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/auth.ts#L104-L179)

Provider save is intentionally two-stage (settings, then credential), checkpointed and idempotently retryable. Delete removes a credential first, but only if the UI can prove it owns the exact derived reference and it is configured+writable; custom, environment, shared, missing, or ambiguous references remain. A crash can leave a partial but observable/retryable state. [`.agents/notes/implemented/bug-fix/2026-08-06-provider-credential-lifecycle.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/bug-fix/2026-08-06-provider-credential-lifecycle.md#L13-L43)

Authorization flows support begin/cancel and require the provider plugin to commit a credential record, but the neutral seam does not define provider-side revoke/logout. Local `unset`/`deleteRecord` revokes Harness access only. [`packages/credentials/authorization/src/index.ts`, flow contract](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/authorization/src/index.ts#L95-L179) [`begin/cancel`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/authorization/src/index.ts#L230-L330)

**Implication:** “rotate in place” matches Harness. FrockBot still needs explicit Connection states and commands for rotate, disconnect/delete, local secret deletion, and optional provider-side revoke, with durable idempotency/reconciliation for partial failure.

### 10. LLM streaming crosses the provider seam as an in-process provider-neutral `AsyncIterable<StreamChunk>`

Adapters alone translate provider wire events. The shared `StreamChunk` union carries indexed block start/delta/end events, usage, and one terminal finish with provider-neutral success/error/aborted reason; usage must precede finish and nothing follows finish. [`packages/llm/llm/src/types.ts`, `StreamChunk`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/types.ts#L259-L294)

The pi-ai adapter maps its SDK events into those chunks, retains raw JSON strings for tool arguments, maps usage, and converts in-band SDK error events into terminal finish chunks. [`packages/llm/llm-pi-ai/src/stream.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/stream.ts#L1-L25) [`toStreamChunks`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/stream.ts#L139-L235)

`LlmRuntime` performs final adapter selection and wraps adapter construction/iteration failures into terminal error/aborted chunks, while middleware/consumer failures remain thrown. Dispatch travels through the `llm/stream` waterfall. [`packages/llm/llm/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts#L958-L1076)

This seam is process-local Cordis/TypeScript; it is not a versioned cross-isolate/cloud DTO and Harness does not place the Agent loop in a Durable Object. FrockBot should copy the vocabulary/normalization rules, but define an explicitly versioned serializable DTO boundary between a Package-owned `LlmProvider` and the Bot Durable Object, and durably record the exact normalized request plus streamed outcomes needed for recovery.

## Comparison with FrockBot's proposed generic Connection design

| FrockBot proposal                                    | Harness fact                                                                                                                                  | Assessment / required action                                                                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account-scoped Connections                           | Harness stores profiles/settings/credentials in one local Harness home; no generic account tenant scope.                                      | **Diverges, intentionally.** Keep backend account ownership and enforce authorization at every Connection command/read.                                                                                            |
| Multiple Connections per Package                     | One pi-ai plugin owns many route profiles, but canonical login records are one per provider ID and the direct DeepSeek adapter has one route. | **Partial match. High priority:** model N opaque Connection instances independently of package/provider slugs, including N OAuth accounts.                                                                         |
| Editable presentation label + opaque ID              | Harness separates editable `displayName` from permanent route ID, but route ID is human-chosen and overloaded.                                | **Matches intent; FrockBot improves identity.** Keep opaque immutable ID and editable label; store package/provider type separately.                                                                               |
| Bot binds Connection ID + model ID                   | Harness logs/binds provider route + model ID.                                                                                                 | **Conceptual match, cleaner in FrockBot.** Snapshot the Connection generation at call preparation and persist both IDs in the exact normalized request.                                                            |
| Authorization kind `none`                            | Reference-free profiles exist, but may use unauthenticated access, ambient AWS/ADC, or provider-native auth.                                  | **Needs revision (high).** Keep `none` only for truly no-auth; add `ambient/native` and provider-managed grant/API-key kinds or a capability-driven equivalent.                                                    |
| Rotate in place                                      | Reference replacement reaches next operation; grant refresh is serialized under the record store.                                             | **Strong match.** Ensure in-flight calls keep their admitted generation and the next call observes rotation. Add durable rotation attempt/outcome events.                                                          |
| Cached dynamic normalized catalogs                   | Harness has installed/configured catalogs and one-shot candidates; it explicitly has no refresh/cache.                                        | **Diverges.** FrockBot's design is stronger, but must specify refresh command, cache version, normalization owner, timestamps, failure state, and per-Connection scoping.                                          |
| Stale-catalog retention                              | Harness keeps previous runtime registration on invalid config/route swap, but has no stale dynamic catalog contract.                          | **Not actually matched.** Define stale catalog as retained last-success data with explicit freshness/error metadata; never silently erase it on refresh failure.                                                   |
| Package-owned `LlmProvider` behind Bot DO Agent loop | Harness adapters own provider wire logic behind `LlmRuntime`; the loop uses neutral messages/chunks. Harness is process-local, not DO-based.  | **Architectural match at the provider seam; deployment divergence is required.** Keep Package ownership, narrow DTOs, DO authority, durable request/effect intent, cancellation, and resumability.                 |
| Manifest/config schema and generated UI              | Harness exports Schemastery config/settings schemas and client metadata, but Models UI is hand-written and curated.                           | **Needs qualification.** Schema-drive decoding/defaults/validation and standard controls; allow Package client Contributions for specialized auth/configuration rather than promising generic UI for every schema. |
| Revoke/delete lifecycle                              | Harness safely deletes only provably UI-owned local references and has no generic upstream revoke contract.                                   | **Gap in proposal if unspecified (high).** Distinguish disable, delete, local credential removal, and upstream revoke; persist partial failure and reconciliation policy.                                          |

## Recommended revisions to the FrockBot design

1. **Define Connection identity independently.** `Connection { id: opaque, accountId, packageId, providerType, label, authorization, settings, lifecycle }`; never use the label/provider slug as a foreign key.
2. **Split configuration from secret material.** Package schemas describe non-secret settings and secret/credential slots, but API responses carry only presence/source/writability/version facts. Secret writes are separate commands and never round-trip literal values.
3. **Broaden authorization vocabulary.** At minimum distinguish `none`, `apiKey`, `ambient/native`, and `grant` (or let the Package declare equivalent capabilities). An absent stored secret must not ambiguously mean unauthenticated, externally supplied, or broken.
4. **Make per-call resolution atomic.** The Bot DO should resolve Connection config generation, exact model metadata/catalog generation, and credential version once, durably log the normalized request, then stream through that captured generation. Rotation/config edits affect the next call only.
5. **Specify catalog state.** Persist `lastSuccessfulCatalog`, `normalizedSchemaVersion`, `refreshedAt`, source, and current refresh error/status. A failed refresh retains the last success and marks it stale. Manual model IDs should remain possible where the provider adapter can resolve them exactly.
6. **Declare lifecycle commands and reconciliation.** Include create/update-label/update-settings, rotate secret, begin/cancel authorization, refresh catalog, disable, delete/disconnect, local credential purge, and optional upstream revoke. Every external effect needs durable intent and idempotency/reconciliation.
7. **Use manifests for capabilities, not all presentation.** A Package Contribution should declare provider type, connection settings schema, authorization methods, catalog/discovery capabilities, and backend `LlmProvider`; optional hosted-client Contributions can own complex UI while core standard fields remain consistent.
8. **Version the stream seam.** Preserve Harness's indexed block/delta/usage/terminal-finish rules in a serializable DTO. Normalize provider throws at the Package boundary, carry cancellation explicitly, and ensure the Bot event log can reconstruct user-visible history and every exact normalized model request.

## Sources

### Kept

- [`packages/llm/llm-pi-ai/src/config.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/config.ts) — current route/profile vocabulary, schema, catalog overrides, and profile resolution.
- [`packages/llm/llm-pi-ai/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/index.ts) — current directory/adapter registration and per-request credential resolution.
- [`packages/llm/llm-pi-ai/src/adapter.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/adapter.ts) — immutable call snapshots and stream dispatch.
- [`packages/llm/llm-pi-ai/src/discovery.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/discovery.ts) — authoritative statement that discovery is not refresh/cache.
- [`packages/llm/llm/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/index.ts) and [`src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm/src/types.ts) — provider-neutral registry, call preparation, model directory, and stream protocol.
- [`packages/credentials/credentials/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/index.ts) and [`src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials/src/types.ts) — current reference/record seams and safe UI descriptors.
- [`packages/credentials/credentials-local/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/credentials-local/src/index.ts) — actual storage, precedence, permissions, locking, and hot reload.
- [`packages/credentials/authorization/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/credentials/authorization/src/index.ts), [`llm-pi-ai/src/auth.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/auth.ts), and [`login.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/llm/llm-pi-ai/src/login.ts) — authorization, grant ownership, refresh, and account cardinality.
- [`packages/client/ui-settings-models/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/client/ui-settings-models/README.md) and [`docs/user/guide/providers.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/user/guide/providers.md) — first-party user-visible semantics and current UI limitations.
- [`2026-08-06-provider-credential-lifecycle.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/bug-fix/2026-08-06-provider-credential-lifecycle.md) — implemented partial-failure and deletion ownership decision.

### Dropped or treated as non-authoritative

- Third-party repositories, forks, discussions summarizing downstream behavior, and search-result commentary — excluded by the first-party-only requirement.
- [`.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/.agents/notes/implemented/architecture/2026-07-14-provider-routed-llm-adapters.md) — useful historical rationale, but several concrete profile details were superseded by settings/credentials, route dictionaries, custom descriptors, and authorization records; current source wins.
- [`docs/cookbook/adding-an-llm-adapter.md`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/docs/cookbook/adding-an-llm-adapter.md) for credential architecture — retained only as evidence of a current documentation inconsistency; its env-in-Config advice is older than the production credential seam.

## Gaps and residual risks

- **No released-version tag was requested.** Findings are pinned to current repository `master` commit `cd5ef814`; published npm artifacts could lag this commit.
- **No generic upstream revoke semantics were found.** Harness proves local record deletion and authorization cancellation, not provider-side token/key revocation. FrockBot must define this independently per Package.
- **No cloud/multi-tenant boundary exists in Harness to copy.** Account scoping, Bot access control, secret isolation, and Durable Object recovery remain FrockBot-specific design work.
- **No durable dynamic-catalog cache exists to benchmark.** Harness cannot validate FrockBot's proposed refresh cadence, normalized schema migration, or stale retention beyond the useful “keep last good runtime state” analogy.
- **Line anchors may move only if readers switch away from the pinned commit.** Every cited material claim uses the immutable `cd5ef814…` blob URL.

## Review findings

1. **High — authorization model:** `authorization.kind = none` is too coarse if it also represents ambient AWS/ADC or provider-native discovery; split true no-auth from ambient/native/provider-managed authorization.
2. **High — lifecycle:** the proposed design must state disable/delete/local purge/upstream revoke behavior and durable reconciliation; “rotate in place” alone is insufficient.
3. **High — account cardinality:** do not key credentials or grants only by Package/provider type. They must be keyed by opaque Connection ID to support multiple accounts, especially multiple OAuth grants.
4. **Moderate — catalog semantics:** cached dynamic catalogs and stale retention are not Harness behavior; document refresh ownership, normalization version, last-success retention, and exact-model fallback explicitly.
5. **Moderate — UI generation:** schemas are excellent validation/description inputs but Harness's production Models UI is intentionally hand-written. Avoid promising fully generated UI from arbitrary Package schemas.
6. **Moderate — Harness source inconsistency:** `docs/cookbook/adding-an-llm-adapter.md` still recommends secret-bearing Cordis config despite the current credential-reference architecture; do not copy that guidance.
7. **No constitutional blocker found:** the recommended Package-owned provider seam, backend account authority, opaque Connection IDs, and Bot Durable Object call ownership align with FrockBot's constitution, provided DTO decoding, durable effect intent, and recovery are specified.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The brief contains ten concrete findings with immutable first-party commit permalinks and file/line anchors, plus severity-ranked review findings and residual risks."
    }
  ],
  "changedFiles": [
    "docs/research/deepseek-harness-connections.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Focused first-party web/source research and pinned-repository inspection at cd5ef8148158c3a752a658978873241fdf8e2bbc",
      "result": "passed",
      "summary": "Inspected official provider, LLM, settings, credentials, authorization, discovery, UI, and lifecycle sources; excluded third-party sources."
    }
  ],
  "validationOutput": [
    "Artifact written to the authoritative runtime output path.",
    "Every material architecture claim cites a deepseek-ai/deepseek-harness immutable commit blob or commit permalink.",
    "Comparison covers all requested FrockBot proposal elements."
  ],
  "residualRisks": [
    "Pinned master source may be newer than published npm artifacts.",
    "Harness has no generic upstream revoke contract, cloud account scope, Durable Object runtime, or durable dynamic-catalog cache to compare directly."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a research-only Markdown brief; no caller worktree or production code was modified.",
  "reviewFindings": [
    "high: generic Connection authorization - split true none from ambient/native/provider-managed authentication",
    "high: Connection lifecycle - define durable delete, local purge, upstream revoke, and reconciliation semantics",
    "high: credential identity - key credentials/grants by opaque Connection ID to support multiple accounts",
    "moderate: catalog design - Harness does not validate the proposed dynamic cache/stale-retention behavior",
    "moderate: UI design - do not assume arbitrary config schemas generate adequate product UI",
    "moderate: official Harness adapter cookbook contains stale secret-in-config advice"
  ],
  "manualNotes": "Research only; no implementation or caller-worktree edit was performed."
}
```
