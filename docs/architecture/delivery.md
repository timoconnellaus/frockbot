# Delivery mechanisms

Merging integrates and a version tag ships. A change reaching `main` does not deploy production. This is the current release arrangement, not a restriction on future hosting technology.

Opening a PR or pushing a version tag starts an obligation to watch it with `bun scripts/ci-watch.ts` through its terminal state. Exit 0 means landed, 1 means failed, and 2 means pending. Inspect failed checks, repair them, and watch again. A published release without its deployment is failed delivery.

## Production secrets

`apps/cloudflare/src/production-secrets.ts` is the manifest of every string setting the Worker reads off `env`. Each name sits in exactly one of three lists: required (production is broken without it, so the deploy fails), optional (the deploy proceeds and says what stays shut), or not deployed as a secret (a `vars` entry, or a door only a test harness opens). Each entry carries the sentence an operator needs when a deploy stops.

The release workflow uses the manifest twice. `bun scripts/check-production-secrets.ts check` runs in the deploy job's validation step, before anything is built, and fails naming the missing secret and what it costs. `check --live` runs immediately before `wrangler deploy`, adding a comparison against the deployed Worker's own secret list, and `write-secrets-file` then writes the JSON that `--secrets-file` consumes — so the list that is checked and the list that is deployed are the same list.

Two facts make this necessary. A secret the code requires but production never had fails silently at the feature, not at the deploy: `APPLET_VIEWER_SECRET` was set in every test environment and in none of production, so every published Applet answered 503 from the day the Applet authority shipped until 2026-09-05. And a release only ever adds to what production holds.

### A release never revokes a secret

`wrangler deploy --secrets-file` is **additive**: it writes the names the file carries and leaves every other secret the Worker holds exactly as it is ("omitted secrets will not be deleted", `wrangler deploy --help`, 4.93). Three consequences, all of them operational:

- **Removing a name from the GitHub production environment does not revoke it.** Releases stop updating that secret; the value production is already running on stays live and stays authorized. An operator who deletes `COMPOSIO_API_KEY` intending to cut Composio off has changed nothing until they revoke it.
- **Revocation is its own deliberate act**: `bun scripts/check-production-secrets.ts revoke <NAME>` deletes one secret from the deployed Worker with `wrangler secret delete`. The release workflow never runs it, and it refuses a required name. Remove the name from the production environment and from the manifest as well, or the next release puts it back.
- **A secret set by hand survives every release**, so `check --live` reports it: `check --live` prints what the deploy actually does — what it adds, what it overwrites, and what it leaves untouched — and warns, without claiming a deletion, about each live secret this release does not carry.

`check --live` fails the release when the deployed Worker holds a setting the manifest marks as one production must never have (`ALLOW_DEVELOPMENT_AUTH`, `WORKSPACE_SEED_TOKEN`, and the other harness doors). No deploy will close such a door, so the gate refuses to ship over the top of it until an operator revokes it.

Adding a setting to the Worker's `Env` interface without classifying it in the manifest fails `apps/cloudflare/src/production-secrets.test.ts`, which also checks that the deploy step's `env:` block carries every deployed name and that the check runs before the deploy.

PRs outside `.github/workflows/` queue themselves after checks pass. A PR editing workflow files cannot be queued by `GITHUB_TOKEN` and must be merged by an authorized human identity. Preserve that operational restriction when changing workflow tooling.

## Native sign-in rollout

The production Worker sets `NATIVE_SLICE_2_AUTH=android`. This deployment-wide switch has no per-User targeting; Android sign-in is available to authenticated Google Users through the existing account policy. The gateway reuses Better Auth and its existing secret/web client. Native session issuance and revocation remain User-DO-owned; PKCE S256, exact HTTPS return, five-minute authorization expiry, one-use exchange and session-bound client compatibility are required. No provider secret enters Dart and Vue/Capacitor keep their existing auth path.

The anonymous `https://bot.frockbot.com/.well-known/assetlinks.json` names `com.frockbot.mobile` and the existing debug certificate SHA-256 `61:E6:47:9F:9C:57:55:15:4C:1F:93:9C:DE:48:E8:A7:57:EF:F3:13:6E:54:ED:1D:DA:5F:61:E7:8B:3C:1E:37`. Flutter and Capacitor share that identity; there is no distinct Capacitor association to replace. Android returns only to `/native/return/android`. Association responses are JSON without authentication or redirect and cache for five minutes. The verification probe must also check GET and HEAD on the DNS-equivalent `bot.frockbot.com.` hostname used by verification fetches. Check both association host spellings for HTTP 200 after the orchestrator's release, then verify Android's domain state. Google's verifier can retain a failed fetch for ten minutes, so a successful direct fetch alone does not prove app-link verification.

`android,macos` additionally admits `/native/return/macos`, only after the existing team `Q444L76529` has supplied a matching signed application and verified-return qualification. The Apple association is published in preparation; publishing it alone does not qualify an ad-hoc Mac build. iOS remains deferred. An absent/unrecognized switch or absent Better Auth secret constructs no native auth handler: reserved native auth/return routes return a plain unavailable response, never fall through to application loading. Removing the switch fences native access without deleting its durable session records; normal expiry/revocation still applies when enabled again.

The switch opens qualification transport, not supported-native distribution or catalog promotion. The [acceptance ledger](../plans/native-acceptance-2026-09-05.md) retains the unproven isolation, eviction and performance gates. Qualification UI/telemetry requires `NATIVE_ACCEPTANCE=true` at build time and has no sign-in entry point. Production releases and Android development APKs remain separate; the orchestrator owns release tags.
