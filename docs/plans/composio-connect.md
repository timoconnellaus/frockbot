# Composio Connect delivery

Owner decision, 2026-09-05. ADR 0042 records the integration and trust boundaries. The later owner clarification supersedes all per-Bot Assignment wording: the User's Connection grants account-wide access. Toolkit names appear directly on Connectors and in tool namespaces; provider plumbing is not product copy.

## Ordered vertical slices

1. Revive the existing package, mount gateway and User Contributions, and implement the provider-derived cached toolkit catalog, managed auth-config creation, Connect Link, public signed callback, revoke, and active-account reconciliation. Merge toolkit entries and remote servers in one searchable Connectors list. Advertise nothing without the API key. Declare and forward production secrets. This PR deliberately declares no tool Capability until the execution path in slice 2 is complete.
2. Declare tools for the User's active Connections, one stable toolkit namespace per connected account through progressive disclosure. Record durable execution intents/results and live revocation refusals. Prove two Bots of one User resolve the same grant and a fake-provider tool call crosses the production seams.
3. Add provider trigger discovery and creation to routine_manage and the Routines UI, signed public webhook delivery into existing Routine hook admission, event-ID deduplication, and durable subscription lifecycle/reconciliation. The User DO owns subscriptions; the Bot DO owns Routines, firings, and completion inbox. Bot-authored Routines use the same command path. Shared provider instances must retain another Routine's enabled subscription.
4. Prove Calendar or Slack through the same catalog, authorization, tool, and trigger paths; document operator-only auth setup.

## Feature gate and validation

Connections and auth-config creation are User DO state. Commands record intent before external calls and durable outcomes afterward. Signed callback state binds the User, Connection, expiry, and native return nonce; public query identity is ignored. Unknown provider outcomes reconcile, never blindly repeat. Only ACTIVE, enabled, correctly owned accounts resolve. Disconnect and eviction do not cancel authorization; alarms recover pending operations without cancelling another Contribution's wake. No Computer is needed. Client projections redact redirect URLs, authorization state, and provider identifiers; provider tokens never leave Composio.

The shared browser/hosted-native surface renders backend catalogs and sends the same commands. Native authorization handoff retains its nonce; native rollout qualification remains governed by the native-app plan. Read and reconnect failures have visible states. Quotas bound connections and catalog pages. Forward migration occurs at the stored-record read seam, not in clients. Parity register row 43 covers multi-account connectors; row 17 covers integration-triggered automation.

Before each PR: typecheck, full Bun tests, formatter, Cloudflare integration suite, architecture scripts, focused provider/callback/eviction tests, rule-by-rule review, and CI through terminal result. Only this worktree is used; commits use --no-verify. Fetch and merge main before each push.

## Judgements and operator setup

The provider supports managed auth-config creation at first use. Creation has an explicit durable intent; an uncertain response is recovered by listing configurations. Custom OAuth still requires dashboard setup. A reconnect uses a fresh hosted Link because the provider API does not preserve its connected-account ID; old access is revoked before authorizing the replacement.

FROCKBOT_AUTHORIZATION_STATE_SECRET moves from deliberately undeployed to required; it must be an independent random value, distinct from BETTER_AUTH_SECRET. COMPOSIO_API_KEY is optional. Trigger delivery will add an optional webhook signing secret. The callback is /api/plugins/composio/callback on the deployment origin. Leave Composio's optional callback identity-verifier mode disabled for this signed-state protocol. Managed OAuth's external consent pages may retain Composio branding; removing that branding requires custom OAuth/white-label dashboard settings.

Review source is the owner's supplied task brief and clarifications; no issue-tracker setup is needed for this explicitly scoped work. New ADR numbering was checked against fetched origin/main and all open PR file lists before choosing 0042.
