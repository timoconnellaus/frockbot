# Delivery mechanisms

Merging integrates and a version tag ships. A change reaching `main` does not deploy production. This is the current release arrangement, not a restriction on future hosting technology.

Opening a PR or pushing a version tag starts an obligation to watch it with `bun scripts/ci-watch.ts` through its terminal state. Exit 0 means landed, 1 means failed, and 2 means pending. Inspect failed checks, repair them, and watch again. A published release without its deployment is failed delivery.

PRs outside `.github/workflows/` queue themselves after checks pass. A PR editing workflow files cannot be queued by `GITHUB_TOKEN` and must be merged by an authorized human identity. Preserve that operational restriction when changing workflow tooling.

## Native sign-in rollout

The production Worker sets `NATIVE_SLICE_2_AUTH=android`. This deployment-wide switch has no per-User targeting; Android sign-in is available to authenticated Google Users through the existing account policy. The gateway reuses Better Auth and its existing secret/web client. Native session issuance and revocation remain User-DO-owned; PKCE S256, exact HTTPS return, five-minute authorization expiry, one-use exchange and session-bound client compatibility are required. No provider secret enters Dart and Vue/Capacitor keep their existing auth path.

The anonymous `https://bot.frockbot.com/.well-known/assetlinks.json` names `com.frockbot.mobile` and the existing debug certificate SHA-256 `61:E6:47:9F:9C:57:55:15:4C:1F:93:9C:DE:48:E8:A7:57:EF:F3:13:6E:54:ED:1D:DA:5F:61:E7:8B:3C:1E:37`. Flutter and Capacitor share that identity; there is no distinct Capacitor association to replace. Android returns only to `/native/return/android`. Association responses are JSON without authentication or redirect and cache for five minutes. The verification probe must also check GET and HEAD on the DNS-equivalent `bot.frockbot.com.` hostname used by verification fetches. Check both association host spellings for HTTP 200 after the orchestrator's release, then verify Android's domain state. Google's verifier can retain a failed fetch for ten minutes, so a successful direct fetch alone does not prove app-link verification.

`android,macos` additionally admits `/native/return/macos`, only after the existing team `Q444L76529` has supplied a matching signed application and verified-return qualification. The Apple association is published in preparation; publishing it alone does not qualify an ad-hoc Mac build. iOS remains deferred. An absent/unrecognized switch or absent Better Auth secret constructs no native auth handler: reserved native auth/return routes return a plain unavailable response, never fall through to application loading. Removing the switch fences native access without deleting its durable session records; normal expiry/revocation still applies when enabled again.

The switch opens qualification transport, not supported-native distribution or catalog promotion. The [acceptance ledger](../plans/native-acceptance-2026-09-05.md) retains the unproven isolation, eviction and performance gates. Qualification UI/telemetry requires `NATIVE_ACCEPTANCE=true` at build time and has no sign-in entry point. Production releases and Android development APKs remain separate; the orchestrator owns release tags.
