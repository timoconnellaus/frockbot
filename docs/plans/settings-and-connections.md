# Settings and Connections Plan

## Status

The approved non-Codex vertical slice is implemented on this branch: durable User and Bot configuration, manifest v3 Packages, explicit Bot Capability Assignments, the hosted settings and Plugins surfaces, and the Composio Gmail Connection with durable authorization, revocation, reconciliation, and assigned Agent tools.

The authoritative current system shape is in [`docs/architecture.md`](../architecture.md), ownership trade-offs are in [ADR 0003](../adr/0003-split-user-connections-from-bot-assignments.md), and domain terms are in [`CONTEXT.md`](../../CONTEXT.md). This plan does not duplicate those contracts.

## Deferred work

- Model-provider and Codex Connections are outside this change. Any later provider vertical slice must keep provider configuration in **Profile → Settings**, model selection in Bot settings, and User defaults limited to newly created Bots.
- Mobile must keep **Plugins** hidden until a native OAuth/deep-link return adapter can complete the hosted Connection protocol.
- External Package discovery, signed distribution, sandboxed third-party settings views, and production secret-vault/KMS support for future write-only credentials remain separate vertical slices.

## Constraints for follow-up slices

- This is a pre-user system: do not add migration, compatibility, fallback, dual-path, or historical-data behavior unless a current fixture explicitly requires it.
- Browser, desktop, and mobile use the same versioned hosted backend protocol; native clients provide only optional platform enhancements.
- Record durable intent before external effects, deduplicate commands and callbacks, reconcile uncertain effects without repeating them, and expose durable failure states.
- Credentials and secret references stay out of client DTOs, application artifacts, session events, logs, and normalized model requests.
- Package installation provides User-level availability only. A Bot receives authority solely through an explicit, durable Capability Assignment.

## Verification focus

Follow-up vertical slices must cover ownership rejection, exact DTO decoding, optimistic revision conflicts, duplicate delivery, disconnect and Durable Object eviction, cancellation races, Connection revocation during Bot execution, runtime reconstruction, protocol parity, and secret redaction.
