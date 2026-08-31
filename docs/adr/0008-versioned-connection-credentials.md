---
status: accepted
---

# Resolve Versioned Connection Credentials per Effect

FrockBot will keep Connection settings and secret material in separate modules. Public settings expose only credential status metadata. The account-authoritative Credential Store encrypts secret records with a versioned backend keyring and issues an opaque, expiring lease for each durable external effect. The Bot Durable Object records the Connection and catalog generations in the normalized model request; the provider Package resolves the leased credential generation once and keeps that immutable generation for the in-flight call.

## Considered options

- **Store API keys in Connection settings:** rejected because normal settings reads, edits, and projections would gain secret authority.
- **Proxy every provider stream through the account Durable Object:** rejected because it introduces a second streaming and cancellation protocol while splitting model-effect execution from the Bot owner.
- **Copy encrypted credentials into Bot history:** rejected because it duplicates secret material into the append-only session authority.
- **Lease one encrypted generation per durable effect:** chosen because settings remain redacted, provider execution stays in the Bot runtime, rotation affects only subsequent effects, and eviction can reacquire the same generation by effect ID.

## Consequences

Credential envelopes authenticate the account, Connection, Package, and generation with AES-GCM associated data. A deployment secret contains the versioned encryption keyring; Connection records never contain it. Rotation stages and validates a pending generation before atomic promotion. Disconnect blocks new leases immediately, while retired generations remain encrypted until admitted leases settle or expire. Provider Packages resolve plaintext only inside their backend runtime adapter and must normalize or redact provider errors before they cross the shared LLM interface.
