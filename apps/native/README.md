# FrockBot client

The one FrockBot client, over the existing cloud commands. Its web build is what `bot.frockbot.com` serves, staged into the app Worker's static assets by `apps/cloudflare/build-flutter-web.ts`. The Android and macOS builds are unqualified: they do not claim Slice 2 acceptance, and [`qualification.json`](qualification.json) records the evidence and what is still missing.

Use Flutter **3.47.0 / Dart 3.13.0**, framework `4cf24164269a5ebf0c16a028a00727d0e77bbb05`, from `/Users/tim/repos/flutter/bin/flutter`. Do not upgrade it. `pubspec.lock` pins WebView **4.14.1**, Android WebView adapter **4.14.1**, WebKit adapter **3.26.1**, and secure storage **11.0.0**.

```sh
export PATH="/Users/tim/repos/flutter/bin:$PATH"
cd apps/native
flutter pub get --enforce-lockfile
flutter analyze --no-pub
# The client names no deployment of its own; the suite passes one that reaches nothing.
flutter test --no-pub --dart-define=FROCKBOT_ORIGIN=https://tests.invalid
```

On this task's restricted Mac, the SDK cache could not be written. An APFS clone of that exact SDK lives under ignored `.native-build/flutter`; `XDG_CONFIG_HOME` and `PUB_CACHE` also point under `.native-build`. It changes no SDK pin or other worktree.

## Voice playback and Bot exchanges

Voice-originated Bot work is one blue **Voice session** exchange, with its request and explicit reply to voice. The card says Queued, Working or Answered from durable Bot state; it does not infer Played from a completed Bot Turn. Explicit `send_to_user` messages remain ordinary messages.

The native speaker uses `com.frockbot/pcm`: Android receipts follow the AudioTrack playback head, and macOS receipts use AVAudioPlayerNode's `dataPlayedBack` callback. Dart acknowledges an exact voice delivery only after `voice/answer-end`, actual PCM received and all device receipts. Silent samples still count as pending audio. Interrupts, discarded audio, device failures and closed/replaced calls invalidate receipts. The browser retains its existing unavailable PCM playback behaviour and cannot acknowledge audio it did not play.

This speaker changes Android native code and removes a native plugin dependency. Its first Android delivery therefore requires a **full enabling APK**, through the release procedure below; it cannot ship as a Dart-only patch. Building or reviewing a PR does not publish or install that APK.

## Android upgrade

Use `scripts/native-acceptance.sh inventory` to record the installed version and certificate, then follow the Shorebird release procedure below. Phone upgrades use `adb install -r` with the exact published APK; never uninstall or clear app data. The acceptance runner’s stock-Flutter build is for qualification, not routine phone delivery.

Only a build that asks for it carries the production identity: Gradle reads `FROCKBOT_ANDROID_RELEASE_IDENTITY=true`, which `scripts/native-update.py`, `scripts/native-acceptance.py install` and the emulator stack in `scripts/native-dev.ts` set. Every other build — a hand-run `flutter build apk` included — is `com.frockbot.mobile.dev`, labelled `FrockBot (Dev)`, and installs beside the phone's real app instead of replacing it. That is the whole point: a stock build carries no Shorebird engine, so one installed over the phone silently ends that install's patch channel, and only a fresh release restores it. `native-acceptance.sh install` does replace it on purpose and now requires `--replace-production` to say so.

## Shorebird releases and patches

`scripts/native-update.py` ships the phone app. A **release** is a full Shorebird APK build; a **patch** is a signed Dart code push against that release. Native code, assets, native plugin dependencies, the engine, the Shorebird `app_id` or the patch key all need a release. Pure-Dart dependency changes may be patched if Shorebird accepts the resulting diff. Shorebird detects native and asset differences and the script never passes `--allow-native-diffs` or `--allow-asset-diffs`.

The client also checks for a patch on cold start and whenever it returns from
the background. A patch staged on disk for the next engine — downloaded by this
launch or already waiting from an earlier one — is offered in the blue update
header. Shorebird's own `auto_update` may already be fetching the same patch at
launch, so when a check's download comes back empty — or fails — the app keeps
reading the disk — a local read every two seconds, for up to two minutes — and
shows the header as soon as the patch lands, rather than waiting for the next
resume. The restart itself checkpoints the local document and then asks `restart_app`
for an Android process restart or an iOS Flutter-engine replacement. Introducing
that native plugin requires a full Shorebird release before this flow can be
delivered; later Dart-only changes to the flow may be patches against that
baseline. This repository still has no iOS Runner, so an eventual iOS target
must configure `RestartAppPlugin.configureEngineRestart` in its AppDelegate
and qualify the new-engine path before claiming iOS delivery.

The Shorebird CLI (1.6.120, logged in to Tim's account) comes from `NATIVE_SHOREBIRD` or `PATH`. The script fails rather than falling back to stock Flutter: a stock build carries no patch key and can never be patched. Shorebird builds with its own Flutter `3.47.0`; the stock development pin above is unchanged. The Android SDK needs command-line tools with `apkanalyzer` even for an APK artifact, plus build-tools: the script inspects the built APK with the newest `aapt`/`apksigner` under `ANDROID_HOME`, and names the missing tool rather than guessing when there are none. Gradle takes the version floor from `FROCKBOT_ANDROID_VERSION_FLOOR` and the production application ID from `FROCKBOT_ANDROID_RELEASE_IDENTITY`, both of which the script sets for every release and patch build.

Keys: `apps/native/shorebird-public-key.pem` is baked into every release. The matching RSA private key lives at ignored `.native-build/updates/shorebird-private.pem` or wherever `NATIVE_SHOREBIRD_PRIVATE_KEY` points; it is never committed. The APK signer is the existing debug keystore the installed app already trusts. Before uploading a patch the script confirms with `openssl` that the two keys are a pair.

State lives under ignored `.native-build/updates/` (`NATIVE_UPDATE_STATE` overrides; the download service reads the same directory). `latest.json` names the immutable `frockbot-<code>-<sha256>.apk` and is replaced atomically. `baseline.json` records the release identity (`1.2.0+<code>`), Shorebird `app_id`, source revision, CLI and Flutter versions, signer and public-key digests, the exact release arguments and every patch cut against it. `pending-release.json` holds the version of an upload that has not been confirmed.

Release:

```sh
bun run native:release                              # or: python3 scripts/native-update.py release
bun run native:release --version-floor <installed versionCode>
bun run native:release --build-number <code>     # retry one uncertain upload at that exact code
```

This runs `shorebird release android --flutter-version=3.47.0 --artifact=apk --target-platform=android-arm64 --build-name=<pubspec version> --build-number=<code> --public-key-path=apps/native/shorebird-public-key.pem`. The code is the larger of the epoch and one above the published/known installed floor, so it always advances. The intent records the release identity before upload. A failed run keeps it and retries that code. If the APK was published but saving `baseline.json` failed, the next run verifies the published APK and metadata against the intent and restores the baseline without another upload. A mismatch stops for reconciliation and preserves the intent. Only after Shorebird’s release list confirms an unresolved upload never reached the service should `pending-release.json` be deleted. The built APK must carry the normal package, the existing signer, the production `app_id` and this repository's public key inside `assets/flutter_assets/shorebird.yaml`; otherwise nothing is published. Publication and the baseline follow.

Install that exact release once on the phone with `adb install -r .native-build/updates/<file>` (same signer, login and history preserved) or from the download link. That first install is what enables patching; the stock `native-acceptance.sh install --replace-production` build carries no patch key, does not count, and ends patching until the next release is installed.

Patch, after `flutter analyze` and `flutter test` pass on the change:

```sh
bun run native:patch # staging track
```

This runs `shorebird patch android --release-version=<baseline version>+<code> --build-name=<baseline version> --build-number=<code> --track=staging --private-key-path=<private> --public-key-path=apps/native/shorebird-public-key.pem -- --target-platform=android-arm64` with the floor one below the release code, so Gradle emits the release's own versionCode whatever is installed now. Both key paths are required, and the name and number are passed explicitly because the CLI otherwise misreads them. The script refuses a missing private key, a missing baseline, a key pair that does not match, or an `app_id`, public key, CLI or Flutter version that differs from the baseline. A patch allocates no APK and no versionCode; `latest.json` is untouched. A published patch is published, not running: only the phone shows what it runs.

Run Shorebird commands from `apps/native` when calling the CLI directly. Commit reviewed source before release or patch uploads. An uncertain patch leaves `pending-patch.json`; inspect the service’s patch list and reconcile that intent before another upload, so retrying cannot create a duplicate.

Staging is validated on a disposable emulator, never on Tim's phone. `shorebird preview` clears the app's data unconditionally, so it must never run against the Pixel:

```sh
shorebird preview --device-id emulator-5554 --platform android --app-id fab29f02-321e-4be1-b478-68dff4398073 --release-version 1.2.0+<code> --track staging   # emulator only
bun run native:promote --release-version 1.2.0+<code> --patch-number <n>                                          # to stable after it works
```

The emulator has shown a signed staging patch download and restart, an offline boot and a remote rollback; a patch signed with the wrong private key is rejected by the CLI before upload. The evidence and what stays unqualified are in the [qualification ledger](../../docs/research/shorebird-qualification-2026-09-09.md). After promotion, launch the installed app on the phone twice and confirm the change is live. The APK download route stays the fallback for a phone that cannot pick up a patch.

The release pipeline cuts this patch itself for every version tag whose `apps/native` differs from the previous tag. `release.yml`'s `Cut Android patch` runs `native-update.py patch --baseline shorebird`, which takes the baseline from Shorebird's release list instead of `baseline.json`: the newest active Android release is, by the rule above, the one installed on the phone. `Promote Android patch` runs `native-update.py promote` after the production deploy. The job installs the CLI version `qualification.json` records, takes the private key and the signer from repository secrets (see the root `README.md`, Releases → Android patches), and its patches show in `shorebird patches list`, not in the local `baseline.json`. Shorebird's native or asset diff verdict leaves the script with exit status 3, which the job reports as needing a full release. Full releases are never cut by the pipeline.

The application retains `com.frockbot.mobile`. Compile SDK 37 is required by secure storage 11; minSdk 24 and targetSdk 36 remain unchanged. Its API-28+ WebView directory is separate from Capacitor's retained directory, and cookies are disabled before the first WebView. API 24–27 isolation remains unqualified. The acceptance build checks only a random continuity sentinel; same-User/Bot re-auth is a separate device check.

## APK download service

The same script serves the published APK over Tailscale on port 8443, reading `latest.json` from the state directory:

```sh
python3 scripts/native-update.py setup   # one-off: launchd agent plus `tailscale serve` on 8443
bun run native:serve                     # run the server in the foreground
python3 scripts/native-update.py publish --apk <path>   # publish an already-built APK
```

`setup` refuses to take over port 8443 from another service, refuses a public Funnel, and refuses a launchd agent pointing at another checkout. The routes are `/frockbot.apk`, `/latest.json` and `/health`; the first two answer 503 until a published APK is actually present on disk. Publishing rejects any APK that is not the normal package with the existing signer, or whose versionCode does not advance the download track.

## macOS

Run `bun run update:desktop` to install a development-signed build on this Mac. The local build is its own app, **FrockBot Dev**: bundle `com.frockbot.mobile.dev`, scheme `frockbot-dev`, a DEV-ribboned icon, installed at `/Users/tim/Applications/FrockBot Dev.app`. It runs beside the released `/Applications/FrockBot.app` without either being opened in place of the other; when the two shared `com.frockbot.mobile`, Launch Services opened the local build, which carries no update feed, and the released app silently stopped receiving updates. The dev build has its own Keychain group and app data, so it signs in separately.

It checks the client protocol against the server compatibility range, runs `flutter build macos --config-only` with `--dart-define=FROCKBOT_DESKTOP_DEV=true`, then `xcodebuild` with `FROCKBOT_DESKTOP_DEV=YES` and `-allowProvisioningUpdates`, verifies the bundle identifier, name, scheme, empty update feed, version, build number, signature and Apple team, then safely replaces and opens the installed app, quitting only FrockBot Dev. It unregisters the `build/` bundles from Launch Services and registers the installed one, so a `frockbot-dev://` return from the browser reaches it; should Launch Services still open another copy, that copy hands the link to the running app and quits (`macos/Runner/AppDelegate.swift`). If an earlier local build is still installed at `/Users/tim/Applications/FrockBot.app` under the released identity, the script says so and suggests removing it; it never deletes it.

The switch lives in `macos/Runner/Configs/AppInfo.xcconfig`: unset (every other build, including the release workflow) it selects `FrockBot`, `com.frockbot.mobile`, `frockbot` and `AppIcon`; `YES` selects `FrockBot Dev`, `com.frockbot.mobile.dev`, `frockbot-dev` and `AppIconDev`. On the Dart side `lib/client/desktop_build.dart` picks the matching scheme and return pages: sign-in returns through `/native/return/macos-dev` and Connect through `/api/connect/callback/macos-dev`, whose pages hand over on `frockbot-dev://`. `AppIconDev` is generated from `AppIcon` by `swift scripts/mac-dev-icon.swift`; run it again whenever the app icon changes. Signing uses the team's Xcode-managed Mac Team Provisioning Profile for `com.frockbot.mobile.dev`, which `-allowProvisioningUpdates` creates or renews while Xcode is signed in to team `Q444L76529`. The previous bundle is restored if installation verification fails; credentials and app data live outside the bundle and are preserved. `--dry-run` checks source versions and prerequisites without building or installing.

Version tags build the public download in `.github/workflows/release.yml`. The macOS job imports a Developer ID Application identity and matching Developer ID provisioning profile into temporary runner storage, builds with Hardened Runtime, verifies the signature and required login/Keychain entitlements, waits for Apple's automated notarization, staples and validates the ticket, packages the stapled app into a Developer ID-signed `FrockBot-macos.dmg` with an Applications shortcut (`scripts/mac-dmg.sh`), notarizes and staples the image as well, and passes it to the GitHub Release job. The same image is then published twice: attached to the GitHub Release as the immutable per-tag provenance record, and written to the `frockbot-downloads` R2 bucket by the `publish-download` job, which is what the website's `/download/mac` redirect actually serves. Neither record is created until that artifact is ready; npm publishing and the production deploys remain independent behind the normal verification gate.

Configure five repository Actions secrets before tagging: `MACOS_DEVELOPER_ID_P12_BASE64`, `MACOS_DEVELOPER_ID_P12_PASSWORD`, `MACOS_DEVELOPER_ID_PROFILE_BASE64`, `APPLE_NOTARIZATION_ID`, and `APPLE_NOTARIZATION_PASSWORD`. The first pair is a base64-encoded, password-protected export of the Developer ID Application identity. The profile secret is a base64-encoded **Developer ID** provisioning profile for `com.frockbot.mobile` that authorizes Associated Domains and Keychain Sharing; a device-scoped Mac Development profile is rejected. The last pair is the Apple Account email and a dedicated app-specific password for notarization. No signing material belongs in the repository.

### In-app updates

A released Mac app updates itself through Sparkle 2 (`macos/Runner/DesktopUpdater.swift`, pinned as a Swift package in `Runner.xcodeproj`). Sparkle shows no windows; when its feed offers a newer build, a blue **Update** control appears beside the profile button in the sidebar (`lib/update/desktop_update.dart`). One press downloads with live percentage while the app stays usable, Sparkle verifies the EdDSA signature and the Developer ID code signature and stages the new bundle, the app checkpoints local state, then quits, installs and relaunches. A failed download or a restart that does not happen leaves the running app untouched and the control offers a retry; an update already staged from an earlier session is offered as **Restart to update**.

The release build writes the feed URL and public key into `Info.plist` through the `FROCKBOT_UPDATE_FEED_URL` and `FROCKBOT_UPDATE_PUBLIC_KEY` build settings. A build without them, including every `bun run update:desktop` install, never starts Sparkle, so a local build is never replaced by the published one; the local build is FrockBot Dev (`com.frockbot.mobile.dev`), so it cannot stand in for the released app either. After the disk image is archived in R2, `publish-download` signs it with `scripts/mac-appcast.py` and writes `mac/appcast.xml` (releases) or `mac/appcast-staging.xml` (prereleases, which are built to follow the staging feed). Each feed names only the newest build, and a feed is never moved to an older one. The update is the same notarized `FrockBot-macos-<version>.dmg` the website serves, at its immutable key.

Configure before the first tag that carries Sparkle: a repository **variable** `SPARKLE_ED_PUBLIC_KEY` and a repository **secret** `SPARKLE_ED_PRIVATE_KEY`. Create them once with Sparkle's `generate_keys` (from the Sparkle release archive), export the private key with `generate_keys -x`, and keep an offline copy: every installed app trusts only that public key, so losing the private key means users must reinstall from the website. The existing `CLOUDFLARE_API_TOKEN` must be able to read R2 objects as well as write them. The cross-platform plan and the release policy are in [`docs/app-updates.md`](../../docs/app-updates.md).

The app uses Apple team `Q444L76529`, bundle `com.frockbot.mobile`, the default protected Keychain group, and the exact associated return domain. Local updates install FrockBot Dev under an Apple Development identity, with the Xcode-managed profile `-allowProvisioningUpdates` creates or renews (above); public releases require the Developer ID equivalents above. Public builds use Hardened Runtime and secure timestamps. Run the updater for native-client and minimum-supported-version changes. Android-only APK releases and Shorebird patches do not need a desktop rebuild. A `CODE_SIGNING_ALLOWED=NO` build plus ad-hoc local signing proves only renderer compilation/launch, never verified links or production credential protection. iOS is not a target in this slice.

The main Mac app is distributed directly rather than through the Mac App Store, with Messages built into Registered machines; the website links a download only once a signed, notarized release is published. Build, signing, notarization and associated-domain requirements are in [the Mac release guide](macos/README.md). The bundle remains `com.frockbot.mobile`; public distribution requires Developer ID signing and a matching profile. Development builds do not prove verified sign-in or distribution readiness. iOS is not a target in this slice.

## Search

The sidebar Search field and Cmd+K (Ctrl+K on other keyboards) open one search palette. Desktop has category tabs and keyboard selection; phones use a full-screen page with a filter menu above the results. Bots appear immediately, with their descriptions and unread indicators. Search includes conversation messages, shared attachments, links, Routines across Bots and shortcuts to the app's existing settings. Group chats are not yet available.

Files and Links return to the source conversation. They index attachments sent with `send_to_user` and URLs in visible conversation text; tool output stays behind an explicit filter. Recent items appear when those categories have no query. Search options also offer archived Bots and rebuilding the index from stored conversations.

Release cleanup: after deploying this search change, use **Search options → Rebuild search index** for each existing test account. This repeatable, account-scoped operation replaces only the derived search index: it adds historical attachments and links and removes previously indexed unspoken completion text. Verify a fresh conversation reply appears in Messages, a shared attachment appears in Files, and a shared URL appears in Links. The original conversations are preserved.

## Web

`bun run --filter @frockbot/cloudflare client:build` is what a deploy runs: it builds this target and stages the payload under `apps/cloudflare/dist/web/_flutter/<buildHash>/`, which is the app Worker's `assets` directory. `bun run dev` from the repository root does the same and serves it. To point a build at another stack:

```sh
flutter build web --release \
  --dart-define=FROCKBOT_ORIGIN=http://127.0.0.1:8797 \
  --dart-define=FROCKBOT_DEV_AUTH=true
```

`dart:io` is confined to `lib/**/*_io.dart`, which a test enforces. Four seams choose an implementation by conditional import: the HTTP client and the state-channel socket (`client/transport_io.dart`, `client/transport_web.dart`), the credential (`client/credential_*.dart`), the sign-in door (`client/auth_*.dart`) and the durable store (`client/plain_store_*.dart`).

The phone holds a PKCE bearer token in the platform keystore and sends it as a header. The browser holds nothing: `withCredentials` carries the ambient better-auth cookie, sign-in navigates to better-auth's Google door, and everything that is not a secret lives in `localStorage`. A cookie is invisible to script, so the account is read off the `<body>` attributes the Worker stamped on the document (`lib/client/identity_web.dart`) and the shell paints before `/api/identity` confirms it.

## Backend and auth

Production enables Android and macOS sign-in with `NATIVE_SLICE_2_AUTH=android,macos`. Wait for the orchestrator’s release and HTTP 200 from the association endpoint before device auth. The `acceptance` block of [`qualification.json`](qualification.json) records how far that rollout got. The anonymous fallback bootstrap is on `https://ui.bot.frockbot.com`.

The app persists PKCE state/verifier before opening the system browser. The gateway uses the existing Better Auth Google web client, returns to an exact HTTPS app link, and exchanges the single-use code under the User Durable Object. The seven-day native session is OS-protected and bound to its client's protocol and catalog hello; the app's own version is compatibility, so updating to another supported version keeps the sign-in, while a version the deployment no longer serves is a 426 telling the person to update. Logout revokes it. A session that expires or is revoked ends the same way from the app's side: a 401 on any request the app authenticated with its own bearer — the sign-in exchange routes aside, where a refusal is of that exchange rather than of a session — forgets that session, in memory first and then in the keystore, and returns to the sign-in door carrying the refusal's own sentence, rather than leaving the cached shell open as if the phone were offline. Send and Stop persist stable ids before dispatch; uncertain sends use lookup then an admission fence; the Bot state channel advances a protected cursor only after the corresponding projection is applied. Disconnect/disposal does not cancel work.

## Extension boundary

A plugin renders by returning a `ViewDocument`, which `lib/view/` draws with the host's own widgets: six node types, no markup and no third-party renderer. The budgets — 512 nodes, depth 16, 262,144 bytes — are checked before the first widget is built, and a document past any of them becomes a host-owned unavailable region rather than a partial view. `embed` names a host region; the host decides what goes in it. A development build reaches `View sample` from the account sheet to look at the renderer before any plugin produces a document.

The Applet fallback never loads the authenticated app or receives its native session. A trusted anonymous bootstrap identifies the exact sandboxed child frame and current navigation epoch. A two-minute User/Applet/generation-scoped viewer token travels only after handshake and uses the WebSocket subprotocol, never a URL. Existing artifacts need rebuilding with the updated Applet SDK handshake. The native host confirms external links before opening the system browser. WebKit's pinned source override selects a nonpersistent store because the public plugin API does not expose it; see its vendor README.

Physical cookie/token/bridge/network isolation, real Applet publication and persisted mutation while the Computer stays hibernated, viewer lifetime fencing, and release budgets remain promotion gates. A sandbox attribute or passing unit test is not OS isolation evidence.

## Acceptance tooling

```sh
scripts/native-acceptance.sh inventory
scripts/native-acceptance.sh install --replace-production
scripts/native-acceptance.sh flow --bot-name 'Fixture Bot' --applet-name 'Fixture Counter'
scripts/native-acceptance.sh measure
```

Google's system-browser consent is a supervised User step. The runner does not enter passwords. Flow selectors and the real device path are unverified until the Pixel is available. Raw output stays in `.native-build/native-acceptance/`. Activity launch time and Android gfxinfo are labelled as such; they do not satisfy first-editable-frame, Flutter raster or physical IME input-to-paint budgets.

`--dart-define=FROCKBOT_APP_VERSION=<name>+<code>` is what the foot of the Profile page shows as the running version, with the booted Shorebird patch number beside it on Android. The release, patch, macOS and web builds all pass it from `pubspec.yaml`; a plain `flutter run` carries none and shows "Development build".

`--dart-define=FROCKBOT_ORIGIN=<origin>` names the deployment this build talks to. The client carries no host of its own: `scripts/native-update.py`, `scripts/native-desktop-update.py`, `scripts/native-acceptance.py` and `release.yml`'s macOS build all read it from `deployments/hosted.json`, so a release and the patches that follow it cannot disagree about which server they reach ([ADR 0028](../../docs/adr/0028-open-deployment.md)). Android's App Link host and the notification tap target are the same value, read by `android/app/build.gradle.kts`. A build that passes neither this nor `FROCKBOT_LOCAL_DEV=true` claims no App Link and refuses its first request rather than guessing an origin; the web build needs none, since the browser serves it from the origin it talks to.

The environment variable `FROCKBOT_ANDROID_RELEASE_IDENTITY=true`, not a define, is what makes an Android build the shipped `com.frockbot.mobile` app with its production Firebase registration; without it the build is the isolated `.dev` app, including a build you make against your own deployment (see [Android upgrade](#android-upgrade)).

`--dart-define=NATIVE_ACCEPTANCE=true` enables bounded frame/input telemetry containing no text or identifiers. Normal builds create no telemetry timer or output. `appInputToFrameMs` excludes hardware/compositor latency. The advisory CI workflow runs analysis/tests only when the exact SDK is already installed, and visibly reports a skip otherwise.
