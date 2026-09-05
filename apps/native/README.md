# FrockBot native qualification prototype

Flutter Android/macOS renderer over the existing cloud commands. The Vue application remains the production client. This prototype does not claim Slice 2 acceptance: see [the evidence and remaining gates](../../docs/plans/native-acceptance-2026-09-05.md).

Use Flutter **3.47.0 / Dart 3.13.0**, framework `4cf24164269a5ebf0c16a028a00727d0e77bbb05`, from `/Users/tim/repos/flutter/bin/flutter`. Do not upgrade it. `pubspec.lock` pins GenUI **0.10.2**, A2UI core **0.1.1**, WebView **4.14.1**, Android WebView adapter **4.14.1**, WebKit adapter **3.26.1**, and secure storage **11.0.0**. The A2UI **0.9.1** source schemas and their exact upstream hashes are in `spec/a2ui-0.9.1/`.

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

The application retains `com.frockbot.mobile`. Its API-28+ WebView directory is separate from Capacitor's retained directory, and cookies are disabled before the first WebView. API 24–27 isolation remains unqualified. The acceptance build checks only a random continuity sentinel; same-User/Bot re-auth is a separate device check.

## macOS

Build with `flutter build macos --release`. The app is configured for Apple team `Q444L76529`, bundle `com.frockbot.mobile`, the default protected Keychain group, and the exact associated return domain. A matching provisioning profile is required. Xcode currently reports no signed-in account/profile. A `CODE_SIGNING_ALLOWED=NO` build plus ad-hoc local signing proves only renderer compilation/launch, never verified links or production credential protection. iOS is not a target in this slice.

## Backend and auth

No deployment enables the prototype by default. `NATIVE_SLICE_2_AUTH=android` enables Android qualification routes; `android,macos` additionally permits the macOS return after its signing gate passes. Deploying the routes and their well-known associations to `https://bot.frockbot.com` is required before device auth. The anonymous fallback bootstrap is on `https://ui.bot.frockbot.com`.

The app persists PKCE state/verifier before opening the system browser. The gateway uses the existing Better Auth Google web client, returns to an exact HTTPS app link, and exchanges the single-use code under the User Durable Object. The seven-day native session is OS-protected and bound to its client protocol/version/catalog hello. Logout revokes it. Send and Stop persist stable ids before dispatch; uncertain sends use lookup then an admission fence; the Bot state channel advances a protected cursor only after the corresponding projection is applied. Disconnect/disposal does not cancel work.

## Extension boundary

The deterministic form uses a bounded FrockBot catalog and zero model calls. Its save fixture persists a User-owned receipt and reconciles duplicate saves. It is a qualification fixture, not a production Package action lifecycle. The compiled candidate catalog is intentionally absent from the advertised client hello.

GenUI's transitive A2UI parser accepts `v0.9`; the adapter constructs typed `v0.9.1` messages for the validated subset. No claim is made for every A2UI feature. Unknown/deep/cyclic/oversized documents become a host-owned unavailable region.

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
