# Composio Connections

Verified against official Composio API references and TypeScript SDK source on 2026-09-05. No production credential or account was used. Provider facts and FrockBot design consequences are distinguished below.

## Owner decision and authority

The owner's 2026-09-05 decision selects hosted Connect Links and REST/TypeScript, not Composio MCP or Composio's Agent/session runtime. Connections grant access account-wide: every Bot of the User can discover and use the account and create Routines using its triggers. There is no per-Bot grant or Assignment. The User Durable Object owns Connection and trigger-subscription records; the Bot Durable Object owns Routine execution.

The product presents toolkit names, logos, descriptions, account aliases, and statuses in one searchable Connectors list alongside existing MCP connectors. Composio is plumbing, not a connector group or a user-facing namespace. Progressive disclosure uses one stable namespace per connected account, named from its toolkit and disambiguated for multiple accounts.

## REST baseline and credentials

Use `https://backend.composio.dev/api/v3.1` and the project API key in `x-api-key`. An auth config is a reusable toolkit-level authentication blueprint; a connected account stores one User's provider authorization. Composio stores and refreshes provider credentials. [Auth configs](https://docs.composio.dev/reference/api-reference/auth-configs), [Connected accounts](https://docs.composio.dev/reference/api-reference/connected-accounts)

Set Composio `user_id` to the immutable FrockBot User ID, never email, a Bot ID, or a shared `default`. Provider ownership then survives email changes and the creation of more Bots. [Authentication](https://docs.composio.dev/docs/authentication)

The account list/get APIs return credential-bearing shapes even when values are masked. Decode an explicit safe projection; discard `state`, arbitrary `data`, credentials, and unexpected fields before persistence or logging. Auth-config responses can also contain credentials. Masking does not make those objects safe to retain. [Credential masking](https://docs.composio.dev/docs/auth-configuration/connected-accounts), [Auth-config response](https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs)

FrockBot consequence: `COMPOSIO_API_KEY` stays a backend secret. Its absence makes the Package advertise nothing. OAuth tokens, Link tokens, webhook secrets, and raw provider error bodies must not enter model arguments or session events.

## Toolkit catalog and first-use auth configs

`GET /toolkits` accepts `search`, `managed_by=composio|all|project`, `type=native|custom|all`, `sort_by=usage|alphabetically`, `category`, `include_deprecated`, `limit` (maximum 1000), and `cursor`. The page contains `items`, `next_cursor`, and page/count fields. Toolkit fields include `slug`, `name`, `auth_schemes`, `composio_managed_auth_schemes`, `no_auth`, and `meta` with `description`, `logo`, `categories`, `tools_count`, `triggers_count`, and `version`. Scheme names in examples are lower-case; normalize them for comparisons. [Toolkit catalog](https://docs.composio.dev/reference/api-reference/toolkits/getToolkits)

`GET /auth_configs` filters by `toolkit_slug` (comma-separated), `is_composio_managed`, `show_disabled`, and `search`, with `limit` up to 50 and `cursor`. Records expose canonical `id`, `toolkit.slug`, `auth_scheme`, `is_composio_managed`, and `status=ENABLED|DISABLED`. Disabled configs are excluded by default. Follow all pages before claiming the complete list. [List auth configs](https://docs.composio.dev/reference/api-reference/auth-configs/getAuthConfigs)

Managed auth can be provisioned through `POST /auth_configs`:

```json
{
  "toolkit": { "slug": "gmail" },
  "auth_config": {
    "type": "use_composio_managed_auth",
    "name": "Gmail"
  }
}
```

The response is `{toolkit:{slug}, auth_config:{id,auth_scheme,is_composio_managed,...}}`. `authConfigs.create(toolkit)` defaults to managed auth in the SDK. Eligible toolkits need no customer OAuth client credentials. [Create config](https://docs.composio.dev/reference/api-reference/auth-configs/postAuthConfigs), [Programmatic auth](https://docs.composio.dev/docs/authentication/programmatic-auth-configs), [SDK translation](https://github.com/ComposioHQ/composio/blob/next/ts/packages/core/src/models/AuthConfigs.ts)

FrockBot consequence: cache safe catalog data server-side. A connector is usable when an enabled supported config exists or when the toolkit explicitly advertises a supported managed flow that can be provisioned on first Connect. Reconcile existing configs before creation and record creation intent. No request idempotency key is documented for config creation; an ambiguous POST must not be blindly retried. Catalog reads must not mass-create configs. Unsupported custom-auth toolkits need operator setup before becoming connectable.

## Connect, reconnect, and disconnect

`POST /connected_accounts/link` requires `auth_config_id` and `user_id`; optional fields include `alias`, `callback_url`, `connection_data`, and experimental sharing configuration. Response fields are `link_token`, `redirect_url`, `expires_at`, and `connected_account_id`. Alias must be unique for the user/toolkit within the project. There is no existing-account ID parameter or REST `allow_multiple` field. [Create Link](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink)

`allowMultiple` is SDK-side policy: `link()` lists active accounts for the user/auth config and refuses a second account unless opted in. It does not forward that flag to REST. The REST client must enforce its own explicit multiple-account policy. [SDK Link implementation](https://github.com/ComposioHQ/composio/blob/next/ts/packages/core/src/models/ConnectedAccounts.ts)

`GET /connected_accounts` accepts `user_ids`, `toolkit_slugs`, `auth_config_ids`, `connected_account_ids`, `statuses`, pagination, and sort fields. Safe fields include `id`, `user_id`, `alias`, `toolkit.slug`, `auth_config.id`, `auth_config.is_disabled`, `status`, `is_disabled`, and timestamps. `GET /connected_accounts/{id}` retrieves one account. Reconcile ownership, toolkit, auth config, and active/disabled state instead of trusting callback success. [List accounts](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts), [Get account](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccountsByNanoid)

Managed OAuth uses `link()`; the managed-OAuth `initiate()` retirement completed by 2026-07-03. `POST /connected_accounts/{id}/refresh` is explicitly deprecated and means re-authentication, not automatic background refresh. A fresh Link does not document preservation of the provider account ID. Preserving FrockBot's Connection ID during reconnect therefore requires an explicit replacement operation and subscription reconciliation. [Migration and account lifecycle](https://docs.composio.dev/docs/auth-configuration/connected-accounts), [Deprecated refresh](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsByNanoidRefresh)

`POST /connected_accounts/{id}/revoke` attempts upstream revocation and returns `connected_account:{id,status:"REVOKED"}` plus revoked token names. Unsupported revocation returns 400; unsuitable state returns 409. `DELETE /connected_accounts/{id}` removes the stored account. Deleting an account is not evidence of upstream token revocation. Fence FrockBot access before cleanup and retain observable cleanup/reconciliation failures. [Revoke account](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsByNanoidRevoke), [Account lifecycle](https://docs.composio.dev/reference/api-reference/connected-accounts)

### Callback security

FrockBot's ordinary callback follows its existing authorization-state precedent: authenticated initiation, durable pending operation and expected provider ID, protected state in `callback_url`, single-use completion, then authenticated backend reconciliation. Query parameters cannot choose an arbitrary User or Connection.

Composio has a separate opt-in project callback identity verifier. It supersedes `callback_url`: the browser receives only `session_uri`; the application redeems it with the signed-in `user_id` at `POST /connected_accounts/complete_auth`. Sessions expire after ten minutes and are single-use. Enabling this dashboard option requires a different supported callback protocol, not merely entering the ordinary callback URL. [Identity verification](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification)

## Tool schemas and execution

`GET /tools` uses singular `toolkit_slug`, optional `auth_config_ids`, `tool_slugs`, `query`, `include_deprecated`, `toolkit_versions`, `limit` up to 1000, and `cursor`. Tools expose `slug`, `name`, `description`, `toolkit`, `input_parameters`, `output_parameters`, `version`, and `available_versions`. `GET /tools/{tool_slug}` returns one definition. Persist the actual schema and resolved version together. [Tool list](https://docs.composio.dev/reference/api-reference/tools/getTools), [Tools](https://docs.composio.dev/reference/api-reference/tools)

`POST /tools/execute/{tool_slug}` takes `{user_id,connected_account_id,arguments,version}`. Its version field is `version`, unlike catalog `toolkit_versions`. Response fields include `successful`, `data`, `error`, and `log_id`. Always specify the account. The endpoint says omitted v3.1 `version` defaults to latest; pinning the catalog's resolved version avoids drift between admission and execution. [Execute tool](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug)

FrockBot consequence: mount tools for the User's enabled active Connections through `call_dynamic_tool`; never silently select another account. Record durable intent before dispatch and safe result afterward. The API documents no universal idempotency-key header or read-only declaration. A timeout after dispatch remains an uncertain effect unless the specific tool has a reconciliation policy. Automatically replaying arbitrary mutations is unsafe. Tool schemas cannot grant credentials, network access, or additional Connections.

## Trigger discovery and lifecycle

`GET /triggers_types` uses plural `toolkit_slugs`, `toolkit_versions`, `limit` up to 50, and `cursor`; it returns paginated `items`. `GET /triggers_types/{slug}` gets one type. Definitions include `slug`, `name`, `description`, `instructions`, `type`, `toolkit`, `config`, `payload`, `version`, and `requires_webhook_endpoint_setup`. Slugs normalize to uppercase. Use the declared config schema in both `routine_manage` discovery and the Routines editor. [List types](https://docs.composio.dev/reference/api-reference/triggers/getTriggersTypes), [Get type](https://docs.composio.dev/reference/api-reference/triggers/getTriggersTypesBySlug)

Create with `POST /trigger_instances/{slug}/upsert` and `{connected_account_id,user_id,trigger_config,toolkit_versions}`; response is `{trigger_id}`. Explicit account selection avoids the first-active-account fallback. Matching existing configuration is reused and a matching disabled instance is re-enabled. The body exposes no caller-issued instance ID, arbitrary metadata, per-instance webhook URL, or request idempotency key. [Upsert trigger](https://docs.composio.dev/reference/api-reference/triggers/postTriggerInstancesBySlugUpsert)

`GET /trigger_instances/active` accepts `connected_account_ids`, `user_ids`, `auth_config_ids`, `trigger_ids`, `trigger_names`, `show_disabled=true`, `limit` up to 50, and `cursor`. Despite its name it can include disabled instances. Records contain `id`, `connected_account_id`, `user_id`, `trigger_name`, `trigger_config`, `version`, and `disabled_at`. Inspect all pages before classifying an instance as missing. [List instances](https://docs.composio.dev/reference/api-reference/triggers/getTriggerInstancesActive)

`PATCH /trigger_instances/manage/{triggerId}` takes `{status:"enable"}` or `{status:"disable"}` and returns `{status:"success"}`. `DELETE` at that path removes the instance. Disabling preserves configuration. [Enable/disable](https://docs.composio.dev/reference/api-reference/triggers/patchTriggerInstancesManageByTriggerId), [Trigger endpoints](https://docs.composio.dev/reference/api-reference/triggers)

FrockBot consequence: every Routine gets its own locally issued subscription record, but identical account/type/config combinations may share one provider instance. Reference-count provider lifecycle: pausing or deleting one Routine must not disable or delete another's active trigger. Changing config uses upsert, moves the local binding, and retires the previous instance when unused. The precise provider configuration-equivalence rule is not documented; compare canonical local config and handle returned-ID collisions. A dropped provider instance is a visible failure; reads must not silently recreate it.

## Webhook registration, verification, and routing

`POST /webhook_subscriptions` accepts `{webhook_url,enabled_events,version:"V3"}` and returns `id`, `webhook_url`, `enabled_events`, `version`, `secret`, and timestamps. **Only one subscription is allowed per project.** Filters select event types such as `composio.trigger.message`, not Users, accounts, or trigger instances. The SDK lists the first existing subscription and updates it, or creates one. [Create subscription](https://docs.composio.dev/reference/api-reference/webhook-subscriptions/postWebhookSubscriptions), [SDK subscription implementation](https://github.com/ComposioHQ/composio/blob/next/ts/packages/core/src/models/Triggers.ts)

`PATCH /webhook_subscriptions/{id}` updates URL, event types, or version. Rotation is separate. The similarly named `webhook_endpoints` API is provider-to-Composio ingress for custom OAuth apps; it cannot supply per-Routine outbound destinations. [Update subscription](https://docs.composio.dev/reference/api-reference/webhook-subscriptions/patchWebhookSubscriptionsById), [Webhook endpoints](https://docs.composio.dev/reference/api-reference/webhook-endpoints)

V3 events have top-level `id`, `type:"composio.trigger.message"`, `timestamp`, `data`, and `metadata` containing `trigger_id`, `trigger_slug`, `connected_account_id`, `auth_config_id`, `user_id`, and `log_id`. Authenticate the raw body before JSON parsing. Headers are `webhook-id`, `webhook-timestamp`, and `webhook-signature`; signed bytes represent `webhook-id + "." + webhook-timestamp + "." + rawBody`. [Receiving events](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events)

Compute HMAC-SHA256 with the **literal UTF-8 secret**, then standard-base64 encode the digest. Do not strip a `whsec_` prefix or base64-decode the key: the SDK uses `new TextEncoder().encode(secret)` directly. Accept a matching `v1,<base64>` entry from the space-separated signature header using constant-time comparison. Reject invalid/missing headers and timestamps outside a bounded tolerance; SDK default is 300 seconds, including future skew. [SDK verifier](https://github.com/ComposioHQ/composio/blob/next/ts/packages/core/src/models/Triggers.ts), [SDK crypto helper](https://github.com/ComposioHQ/composio/blob/next/ts/packages/core/src/utils/crypto.ts)

Delivery is at least once. Composio recommends deduplication on a stable webhook event ID, `log_id`, or provider event/message ID. FrockBot must persist receipt/admission keyed by event ID and local subscription, then call `ROUTINE_HOOK` with a deterministic idempotency key. Replays and crash recovery must not produce another firing. Timestamp checks alone do not deduplicate legitimate retries. [Delivery guidance](https://docs.composio.dev/kb/guide/platform-triggers)

### Routing without payload identity as authority

The documented API cannot echo an arbitrary FrockBot subscription ID or register an opaque callback URL per User/Routine. Do not invent these fields or try one project subscription per User.

The selected FrockBot routing design is an inference from the verified APIs:

1. The public gateway verifies the project signature and bounded V3 envelope.
2. It ignores payload `user_id` as identity. It treats `connected_account_id` only as a lookup key and retrieves that account through the authenticated Composio API. The reconciled immutable FrockBot `user_id` identifies the candidate User Durable Object.
3. That Durable Object must match its own locally issued Connection and subscription records, including the FrockBot-issued account alias, exact provider account and trigger IDs, trigger type, and enabled lifecycle. Neither provider response nor payload can create a grant or subscription.
4. It dispatches only the stored Bot and Routine IDs under the local opaque subscription ID. It never accepts event-supplied destinations. The Bot verifies its Routine binding and admits the event durably.

This requires no global routing registry. Provider reconciliation supplies routing metadata; FrockBot's durable records alone authorize execution. If the provider account has vanished, fail closed instead of falling back to the payload's User ID. Trigger-instance reconciliation can add another cross-check. This is application policy, not a provider feature.

## Operator setup and limits

- Register one public HTTPS webhook URL with V3 trigger events and install the returned secret as backend-only `COMPOSIO_WEBHOOK_SECRET`. Missing signing configuration makes service-event Routines unavailable. Do not rotate or replace the project subscription during ordinary Connection reads. [Webhook subscriptions](https://docs.composio.dev/reference/api-reference/webhook-subscriptions)
- Managed auth configs can be created at first use. Toolkits without an eligible managed flow need operator-supplied custom auth configs. Custom OAuth trigger types requiring webhook endpoint setup also need provider-side event registration through Composio's ingress configuration. [Programmatic auth](https://docs.composio.dev/docs/authentication/programmatic-auth-configs), [Custom OAuth webhooks](https://docs.composio.dev/docs/setting-up-triggers/custom-oauth-webhooks)
- FrockBot can hide Composio in its own copy. Hosted Link branding needs project White Labeling settings; removing the Composio name on provider consent screens and the hosted security badge requires FrockBot's own OAuth apps. Managed OAuth alone cannot promise that external screens never name Composio. [White-labeling](https://docs.composio.dev/docs/authentication/white-labeling-authentication)
- No general fake-provider OAuth sandbox or universal mutation idempotency contract was established. The deterministic end-to-end harness should provide a fake Composio HTTP backend using these schemas and exercise the production callback/tool/webhook paths. Real consent, toolkit-specific scopes, and upstream delivery remain an account-backed smoke check.
- Reference examples sometimes abbreviate JSON Schema into field maps. Keep fixtures faithful to actual responses; do not assume every object is a complete JSON Schema document. Catalog, tool-execution, and trigger version parameters also differ as documented above.

## Tool execution verification (2026-09-05)

The current [v3.1 tool list](https://docs.composio.dev/reference/api-reference/tools/getTools) uses `toolkit_slug` (singular), supports `auth_config_ids`, returns `input_parameters` plus dated `version`, and paginates with `cursor`. The dormant client used an incorrect plural filter. [Execution](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug) takes `connected_account_id`, `user_id`, `version`, and `arguments`; its response distinguishes `successful` and `data`. FrockBot pins dated definitions and forwards only action data; it does not use proxy execution or credential overrides. No execution idempotency header is documented, so interrupted effects are explicitly unrecoverable without inspecting the external account.
