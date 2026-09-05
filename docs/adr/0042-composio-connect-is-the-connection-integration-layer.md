---
status: accepted
date: 2026-09-05
---

# Composio Connect is the integration layer for user Connections

Use hosted Connect Link and the v3.1 REST API, never Composio MCP. Composio retains OAuth credentials; FrockBot retains the authorization lifecycle in the User Durable Object. The immutable FrockBot User ID is the provider's `user_id`. Each account is a separate Connection, granting access to every Bot of its User under ADR 0019. Only an active, live-authorized Connection resolves.

The Connectors surface presents a searchable toolkit catalog alongside remote servers. Toolkit names, descriptions, and icons come from a bounded, server-cached catalog of usable auth configurations, including managed OAuth configurations creatable at first use. A manifest-declared catalog supplies variants of one Connection Type; variants never grant authority independently. Provider IDs and branding are implementation details, absent from product copy. Multiple accounts retain separate labels and stable toolkit-named namespaces under ADR 0023.

The gateway signs an expiring, single-use authorization state using the dedicated authorization-state secret and dispatches its public callback before session authentication, exactly as the MCP OAuth callback does. Only verified state selects the User DO. The DO verifies the provider account's User, toolkit, and admitted account identity before consuming the state. Every provider mutation has a durable intent and explicit reconciliation; an uncertain response is never permission to repeat a mutation. Revocation fences subsequent effects even inside a pinned Turn.

Composio trigger subscriptions belong to the User DO; Routines and firing admission belong to the Bot DO. A signed provider webhook enters the existing Routine hook admission path, using the provider event ID for deduplication and the event data as input. The provider supports one project webhook endpoint and supplies no caller-defined routing metadata. After signature verification, the backend looks up the provider account using authenticated REST; its recorded User ID is a routing hint only. The User DO authorizes exclusively against the FrockBot-issued Connection identity (also the provider alias), its durable subscription, and matching provider account and trigger IDs. Payload identity never chooses a Bot or Routine. Identical provider trigger instances require shared lifecycle accounting: pausing or deleting one Routine must not disable another's subscription.

Connection and subscription reads reconcile provider status. Disconnect, eviction, and Computer hibernation do not cancel admitted work. Unknown provider outcomes remain durable, visible, and recoverable. Routines use the existing background lane and completion inbox; no new Agent loop is introduced. These integrations extend the parity register's external-service and automation capabilities.

## Consequences

- `COMPOSIO_API_KEY` is backend-only and optional: without it the Package advertises nothing. The authorization-state secret is required for production authorization callbacks. Trigger delivery additionally needs the optional dashboard webhook signing secret.
- Managed OAuth requires no User configuration beyond connecting. Auth configurations are created by API on first use with a durable creation intent, and uncertain creation is reconciled by listing configurations. Custom OAuth and externally hosted consent-screen branding may require operator dashboard setup.
- This replaces the temporarily proposed Composio Connect MCP redesign. It does not restore per-Bot Assignments or the former direct Agent authorization path.
