# Native Slice 2 implementation ledger

This is an explicit qualification prototype, beyond parity, alongside the unchanged Vue client. Production promotion is blocked until the device, signing, isolation and recovery gates in [the native plan](native-app.md) pass. The compiled catalog is not advertised to production clients during qualification.

## Feature rule before implementation

- **Authority:** Better Auth establishes the existing Google identity. The User Durable Object owns native session issuance, compatibility binding, replay records and revocation. The Bot Durable Object remains the owner of conversation admission, receipt lookup, Stop and observer cursors. The Applet Durable Object remains the owner of viewer access and facet state.
- **State and commands:** native authorization uses a short-lived signed PKCE request, an authenticated browser callback, and a one-use exchange recorded by the User owner. A session carries the pinned client hello. Dart retains only protected session credentials and recoverable local command/draft records; these never establish admission. Existing turn, lookup, fence, Stop and conversation page contracts are reused.
- **Disconnect and eviction:** client disposal detaches observation. A persisted pending send is looked up before any new send; an absent lookup is fenced before retry. The owner retains native sessions across eviction. Neither login nor chat invokes the Computer.
- **Retry and cancellation:** PKCE exchange replay is refused. Lost exchange responses require signing in again. Send and Stop IDs are persisted before dispatch and reused; reconnect never sends Stop. A browser cancelled before exchange creates no native session.
- **Trust:** only the existing Google web OAuth client is used; no client secret enters Dart. Native sessions use OS-protected storage. Return links are exact HTTPS paths associated with the actual Android certificate / Apple signing team. Missing signing evidence blocks that target's auth qualification. Untrusted regions receive no native session or general native bridge.
- **Projection and controls:** system browser sign-in, Bot navigation, paged conversation, composer, explicit Stop, connection status and extension recovery are native host controls over shared backend routes. No model/configuration/grant controls are added. Native selection is a local preference, never Bot configuration.
- **Failure and evidence:** shared protocol and state-machine tests, auth replay/redirect/expiry tests, hostile document rejection, signer/data continuity, real Applet persistence and release traces are required. Missing evidence is recorded as unqualified, never inferred from tests or a mock.
- **Scope:** native qualification is beyond parity. Vue remains the working browser renderer; this ledger changes no constitutional invariant.

## Qualification record

Measured evidence and remaining gates belong in [the dated acceptance report](native-acceptance-2026-09-05.md). A feature PR requires the final constitutional review; a failed technology boundary is an explicit prototype result, not permission to enable it.
