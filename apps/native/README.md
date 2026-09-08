# FrockBot native qualification prototype

Flutter Android/macOS renderer over the existing cloud commands. The Vue application remains the production client. This prototype does not claim Slice 2 acceptance: see [the evidence and remaining gates](../../docs/plans/native-acceptance-2026-09-05.md).

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

Use `scripts/native-acceptance.sh inventory`, then `scripts/native-acceptance.sh install` from the repository root. The runner waits for the already-paired Pixel, pulls the installed APK, compares its certificate, reads its installed versionCode, and builds `1.1.0` with the next code. Gradle refuses a missing existing keystore or an absent/stale installed code. The runner uses `adb install -r`; it never uninstalls, clears data or generates a key. No signing key is committed.

The application retains `com.frockbot.mobile`. Compile SDK 37 is required by secure storage 11; minSdk 24 and targetSdk 36 remain unchanged. Its API-28+ WebView directory is separate from Capacitor's retained directory, and cookies are disabled before the first WebView. API 24–27 isolation remains unqualified. The acceptance build checks only a random continuity sentinel; same-User/Bot re-auth is a separate device check.

## macOS

Build with `flutter build macos --release`. The app is configured for Apple team `Q444L76529`, bundle `com.frockbot.mobile`, the default protected Keychain group, and the exact associated return domain. A matching provisioning profile is required. Xcode currently reports no signed-in account/profile. A `CODE_SIGNING_ALLOWED=NO` build plus ad-hoc local signing proves only renderer compilation/launch, never verified links or production credential protection. iOS is not a target in this slice.

## Web

`flutter build web --release` is a supported target and the advisory workflow builds it. Nothing serves it yet: `bot.frockbot.com` still ships the Vue bundle, and the Worker route that replaces it is the next change. To look at it now, build and serve `build/web` with any static server.

```sh
flutter build web --release \
  --dart-define=FROCKBOT_ORIGIN=http://127.0.0.1:8797 \
  --dart-define=FROCKBOT_DEV_AUTH=true
```

`dart:io` is confined to `lib/**/*_io.dart`, which a test enforces. Four seams choose an implementation by conditional import: the HTTP client and the state-channel socket (`client/transport_io.dart`, `client/transport_web.dart`), the credential (`client/credential_*.dart`), the sign-in door (`client/auth_*.dart`) and the durable store (`client/plain_store_*.dart`).

The phone holds a PKCE bearer token in the platform keystore and sends it as a header. The browser holds nothing: `withCredentials` carries the ambient better-auth cookie, sign-in navigates to better-auth's Google door, and everything that is not a secret lives in `localStorage`. Bootstrapping from that cookie is not wired up yet, so a browser reaches the sign-in screen and stops there. The Applet fallback WebView has no web implementation and is hidden on the web.

## Backend and auth

Production enables Android qualification transport with `NATIVE_SLICE_2_AUTH=android`; `android,macos` additionally permits the macOS return after its signing gate passes. Wait for the orchestrator’s release and HTTP 200 from the association endpoint before device auth. See the [rollout ledger](../../docs/plans/native-acceptance-2026-09-05-slice3.md). The anonymous fallback bootstrap is on `https://ui.bot.frockbot.com`.

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
