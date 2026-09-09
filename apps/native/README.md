# FrockBot client

The one FrockBot client, over the existing cloud commands. Its web build is what `bot.frockbot.com` serves, staged into the app Worker's static assets by `apps/cloudflare/build-flutter-web.ts`. The Android and macOS builds are unqualified: they do not claim Slice 2 acceptance, and [`qualification.json`](qualification.json) records the evidence and what is still missing.

Use Flutter **3.47.0 / Dart 3.13.0**, framework `4cf24164269a5ebf0c16a028a00727d0e77bbb05`, from `/Users/tim/repos/flutter/bin/flutter`. Do not upgrade it. `pubspec.lock` pins WebView **4.14.1**, Android WebView adapter **4.14.1**, WebKit adapter **3.26.1**, and secure storage **11.0.0**.

```sh
export PATH="/Users/tim/repos/flutter/bin:$PATH"
cd apps/native
flutter pub get --enforce-lockfile
flutter analyze --no-pub
flutter test --no-pub
```

On this task's restricted Mac, the SDK cache could not be written. An APFS clone of that exact SDK lives under ignored `.native-build/flutter`; `XDG_CONFIG_HOME` and `PUB_CACHE` also point under `.native-build`. It changes no SDK pin or other worktree.

## Android upgrade

Use `scripts/native-acceptance.sh inventory` to record the installed version and certificate, then follow the Shorebird release procedure below. Phone upgrades use `adb install -r` with the exact published APK; never uninstall or clear app data. The acceptance runner’s stock-Flutter build is for qualification, not routine phone delivery.

## Shorebird releases and patches

`scripts/native-update.py` ships the phone app. A **release** is a full Shorebird APK build; a **patch** is a signed Dart code push against that release. Native code, assets, native plugin dependencies, the engine, the Shorebird `app_id` or the patch key all need a release. Pure-Dart dependency changes may be patched if Shorebird accepts the resulting diff. Shorebird detects native and asset differences and the script never passes `--allow-native-diffs` or `--allow-asset-diffs`.

The Shorebird CLI (1.6.120, logged in to Tim's account) comes from `NATIVE_SHOREBIRD` or `PATH`. The script fails rather than falling back to stock Flutter: a stock build carries no patch key and can never be patched. Shorebird builds with its own Flutter `3.47.0`; the stock development pin above is unchanged. The Android SDK needs command-line tools with `apkanalyzer` even for an APK artifact, plus build-tools: the script inspects the built APK with the newest `aapt`/`apksigner` under `ANDROID_HOME`, and names the missing tool rather than guessing when there are none. Gradle takes the version floor from `FROCKBOT_ANDROID_VERSION_FLOOR`, which the script sets for every build.

Keys: `apps/native/shorebird-public-key.pem` is baked into every release. The matching RSA private key lives at ignored `.native-build/updates/shorebird-private.pem` or wherever `NATIVE_SHOREBIRD_PRIVATE_KEY` points; it is never committed. The APK signer is the existing debug keystore the installed app already trusts. Before uploading a patch the script confirms with `openssl` that the two keys are a pair.

State lives under ignored `.native-build/updates/` (`NATIVE_UPDATE_STATE` overrides; the download service reads the same directory). `latest.json` names the immutable `frockbot-<code>-<sha256>.apk` and is replaced atomically. `baseline.json` records the release identity (`1.1.0+<code>`), Shorebird `app_id`, source revision, CLI and Flutter versions, signer and public-key digests, the exact release arguments and every patch cut against it. `pending-release.json` holds the version of an upload that has not been confirmed.

Release:

```sh
bun run native:release                              # or: python3 scripts/native-update.py release
bun run native:release --version-floor <installed versionCode>
bun run native:release --build-number <code>     # retry one uncertain upload at that exact code
```

This runs `shorebird release android --flutter-version=3.47.0 --artifact=apk --target-platform=android-arm64 --build-name=1.1.0 --build-number=<code> --public-key-path=apps/native/shorebird-public-key.pem`. The code is the larger of the epoch and one above the published/known installed floor, so it always advances. The intent records the release identity before upload. A failed run keeps it and retries that code. If the APK was published but saving `baseline.json` failed, the next run verifies the published APK and metadata against the intent and restores the baseline without another upload. A mismatch stops for reconciliation and preserves the intent. Only after Shorebird’s release list confirms an unresolved upload never reached the service should `pending-release.json` be deleted. The built APK must carry the normal package, the existing signer, the production `app_id` and this repository's public key inside `assets/flutter_assets/shorebird.yaml`; otherwise nothing is published. Publication and the baseline follow.

Install that exact release once on the phone with `adb install -r .native-build/updates/<file>` (same signer, login and history preserved) or from the download link. That first install is what enables patching; the stock `native-acceptance.sh install` build carries no patch key and does not count.

Patch, after `flutter analyze` and `flutter test` pass on the change:

```sh
bun run native:patch # staging track
```

This runs `shorebird patch android --release-version=1.1.0+<code> --build-name=1.1.0 --build-number=<code> --track=staging --private-key-path=<private> --public-key-path=apps/native/shorebird-public-key.pem -- --target-platform=android-arm64` with the floor one below the release code, so Gradle emits the release's own versionCode whatever is installed now. Both key paths are required, and the name and number are passed explicitly because the CLI otherwise misreads them. The script refuses a missing private key, a missing baseline, a key pair that does not match, or an `app_id`, public key, CLI or Flutter version that differs from the baseline. A patch allocates no APK and no versionCode; `latest.json` is untouched. A published patch is published, not running: only the phone shows what it runs.

Run Shorebird commands from `apps/native` when calling the CLI directly. Commit reviewed source before release or patch uploads. An uncertain patch leaves `pending-patch.json`; inspect the service’s patch list and reconcile that intent before another upload, so retrying cannot create a duplicate.

Staging is validated on a disposable emulator, never on Tim's phone. `shorebird preview` clears the app's data unconditionally, so it must never run against the Pixel:

```sh
shorebird preview --device-id emulator-5554 --platform android --app-id fab29f02-321e-4be1-b478-68dff4398073 --release-version 1.1.0+<code> --track staging   # emulator only
shorebird patches promote --release-version 1.1.0+<code> --patch-number <n>                                       # to stable after it works
```

The emulator has shown a signed staging patch download and restart, an offline boot and a remote rollback; a patch signed with the wrong private key is rejected by the CLI before upload. The evidence and what stays unqualified are in the [qualification ledger](../../docs/research/shorebird-qualification-2026-09-09.md). After promotion, launch the installed app on the phone twice and confirm the change is live. The APK download route stays the fallback for a phone that cannot pick up a patch.

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

Build with `flutter build macos --release`. The app is configured for Apple team `Q444L76529`, bundle `com.frockbot.mobile`, the default protected Keychain group, and the exact associated return domain. A matching provisioning profile is required. Xcode currently reports no signed-in account/profile. A `CODE_SIGNING_ALLOWED=NO` build plus ad-hoc local signing proves only renderer compilation/launch, never verified links or production credential protection. iOS is not a target in this slice.

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

Production enables Android qualification transport with `NATIVE_SLICE_2_AUTH=android`; `android,macos` additionally permits the macOS return after its signing gate passes. Wait for the orchestrator’s release and HTTP 200 from the association endpoint before device auth. The `acceptance` block of [`qualification.json`](qualification.json) records how far that rollout got. The anonymous fallback bootstrap is on `https://ui.bot.frockbot.com`.

The app persists PKCE state/verifier before opening the system browser. The gateway uses the existing Better Auth Google web client, returns to an exact HTTPS app link, and exchanges the single-use code under the User Durable Object. The seven-day native session is OS-protected and bound to its client protocol/version/catalog hello. Logout revokes it. Send and Stop persist stable ids before dispatch; uncertain sends use lookup then an admission fence; the Bot state channel advances a protected cursor only after the corresponding projection is applied. Disconnect/disposal does not cancel work.

## Extension boundary

A plugin renders by returning a `ViewDocument`, which `lib/view/` draws with the host's own widgets: six node types, no markup and no third-party renderer. The budgets — 512 nodes, depth 16, 262,144 bytes — are checked before the first widget is built, and a document past any of them becomes a host-owned unavailable region rather than a partial view. `embed` names a host region; the host decides what goes in it. A development build reaches `View sample` from the drawer to look at the renderer before any plugin produces a document.

The Applet fallback never loads the authenticated app or receives its native session. A trusted anonymous bootstrap identifies the exact sandboxed child frame and current navigation epoch. A two-minute User/Applet/generation-scoped viewer token travels only after handshake and uses the WebSocket subprotocol, never a URL. Existing artifacts need rebuilding with the updated Applet SDK handshake. The native host confirms external links before opening the system browser. WebKit's pinned source override selects a nonpersistent store because the public plugin API does not expose it; see its vendor README.

Physical cookie/token/bridge/network isolation, real Applet publication and persisted mutation while the Computer stays hibernated, viewer lifetime fencing, and release budgets remain promotion gates. A sandbox attribute or passing unit test is not OS isolation evidence.

## Acceptance tooling

```sh
scripts/native-acceptance.sh inventory
scripts/native-acceptance.sh install
scripts/native-acceptance.sh flow --bot-name 'Fixture Bot' --applet-name 'Fixture Counter'
scripts/native-acceptance.sh measure
```

Google's system-browser consent is a supervised User step. The runner does not enter passwords. Flow selectors and the real device path are unverified until the Pixel is available. Raw output stays in `.native-build/native-acceptance/`. Activity launch time and Android gfxinfo are labelled as such; they do not satisfy first-editable-frame, Flutter raster or physical IME input-to-paint budgets.

`--dart-define=NATIVE_ACCEPTANCE=true` enables bounded frame/input telemetry containing no text or identifiers. Normal builds create no telemetry timer or output. `appInputToFrameMs` excludes hardware/compositor latency. The advisory CI workflow runs analysis/tests only when the exact SDK is already installed, and visibly reports a skip otherwise.
