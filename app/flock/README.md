# @frockbot/app/flock

Built-in Package for durable Bot registration and character identity.

- Gateway Contribution: authenticated exact v1 Bot directory, avatar and voice routes.
- User Contribution: bounded directory, creation-time registration seeds, optimistic revision, durable create receipts, the [avatar mirror](#the-avatar-mirror), and [General bootstrap](#general-bootstrap).
- Bot Contribution: idempotent materialization and durable avatar and voice update receipts.
- Hosted client Contribution: Bot list/create/switch and responsive character picker in generic shell outlets.

The native client bundles eleven approved Rive characters with neutral PNG fallbacks. Appearance is a character id plus a validated primary colour.

## The avatar mirror

The Bot Durable Object is the authority on a Bot's avatar: it holds the identity, and an update command is fenced on that identity's revision. But every list of Bots draws its appearance from the User's directory registration, so a change that lived in the Bot alone came back undone on the next directory read. A change therefore goes through the User's `updateBotAvatar`, which calls the Bot's `updateAvatar` and, once the Bot reports the command applied, mirrors the appearance into the registration with `mirrorAvatar` — one directory revision, a no-op when the appearance is unchanged or the Bot is no longer listed. A registration's `avatar` is therefore the Bot's current appearance, not a creation-time seed like `initialName` and `initialDescription`.

What is mirrored is the avatar the Bot reports wearing, read back from it, rather than the one the command asked for. The Bot answers a replayed command from its stored receipt without touching its identity, so a mirror write lost between the two calls heals on the retry while a stale replay cannot drag the directory back to an older appearance.

## The voice mirror

A Bot's voice ([ADR 0031](../../docs/adr/0031-voice-gemini-live.md)) follows the avatar exactly: the Bot Durable Object holds `flock:voice:v1` and fences `bot/update-voice` on its own revision, and the User's `updateBotVoice` mirrors the voice the Bot reports wearing into the registration, because the voice session opens a call from the directory rather than from the Bot object. The two records have separate revisions, so changing how a Bot sounds never races a change to how it looks.

A registration without `voice` is the ordinary case, not a gap: it means nobody chose, and `resolveBotVoiceV1` answers with the character's default. The Bot's record is seeded lazily on first read, so a Bot registered before voices existed needs no migration.

## General bootstrap

The User Durable Object's `assertUserIdentity` calls `provisionGeneral` before answering admitted account requests, once per instance. The read-only signup-policy probe does not bootstrap an account or change admission policy.

When the directory is empty and no `flock:bootstrap:v1` marker exists, `provisionGeneral` registers General under a freshly minted id in the same transaction as the marker that names it. Concurrent calls and interrupted writes cannot leave a registration without its marker. Existing empty accounts are backfilled through the same path; accounts already owning Bots receive only the marker, preserving their registrations. The marker survives deletion, so General is never re-provisioned, and a fresh id avoids reusing an old tombstoned Bot object. The marker is additive: existing registration shapes and codecs are unchanged, so no incompatible stored-data cleanup is needed.

`readBootstrap`, exposed as authenticated `GET /api/bots/bootstrap`, projects the recorded id while the Bot remains registered, or `null` otherwise. Clients use this projection rather than inferring General from a name or directory order. See the [first-run guidance](../../README.md#getting-started) for client behavior.
