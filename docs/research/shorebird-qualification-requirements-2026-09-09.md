# Shorebird Android qualification requirements

Checked 2026-09-09 against primary Shorebird documentation and the current native build files. This reference describes vendor capabilities and constraints. Observed results and remaining limits are in the [qualification ledger](shorebird-qualification-2026-09-09.md).

## Fit and limits

Shorebird supports Dart and widget changes, including pure-Dart dependencies. Native Android code, native plugin implementations, manifest/permission changes and engine upgrades require a replacement APK. [Code Push guide](https://docs.shorebird.dev/code-push/guides/code-push-guide/)

Asset patching is currently unsupported: bundled images, fonts and `pubspec.yaml` assets require a new release. The patch checklist also requires matching the release's Flutter SDK. `shorebird patch android --release-version VERSION+BUILD` explicitly selects the release to update; its default track is stable, so a qualification patch must explicitly select staging. [Create a Patch](https://docs.shorebird.dev/code-push/patch/)

Android sideloading and MDM are explicitly supported; Play distribution is unnecessary. `shorebird release android --artifact apk` produces APK and AAB artifacts. `--flutter-version`, `--build-name`, `--build-number` and `--dry-run` are documented release options. The runtime must first reach the phone through an enabling APK. [Create a Release](https://docs.shorebird.dev/code-push/release/)

Release identity includes both version and build number. Patches have their own increasing patch number and apply to one release. [Code Push overview](https://docs.shorebird.dev/code-push/)

## Repository consequences

The inspected [pubspec](../../apps/native/pubspec.yaml) pins Flutter 3.47.0 and Dart 3.13.x, with WebView, secure storage, app links, path provider and URL launcher dependencies, sheep assets and two bundled fonts. The [native README](../../apps/native/README.md) additionally pins framework revision `4cf24164269a5ebf0c16a028a00727d0e77bbb05` and prohibits an SDK upgrade. **Support for the exact pinned version and compatibility with Shorebird's modified runtime must be demonstrated; a version number alone is not evidence.**

The [Android build](../../apps/native/android/app/build.gradle.kts) preserves production package `com.frockbot.mobile` and the existing signer, requires an explicit version floor, and rejects build numbers at or below it. Compile/min/target SDKs are 37/24/36. These must survive the enabling release.

The [APK publisher](../../scripts/native-update.py) allocates a new timestamp-based build number on every build and refuses non-increasing publications. **Inference:** retain that allocation for full APK releases, but use a distinct patch invocation targeting the original release number, with a valid build-time floor below that number. Do not publish the patch build as an APK or advance the APK download metadata. Record each baseline's source, dependencies, build inputs and exact release identity so the next patch is reproducible. The delivery helper implements separate full-release and patch paths; see the native README for operation.

## Signing and recovery

Optional developer-controlled patch signing is documented for all platforms. Embed an RSA PEM public key in the enabling release with `--public-key-path`; sign patches with the corresponding private key via `--private-key-path` (or documented KMS command options). Keys may be PKCS#1 or PKCS#8. Releases containing the public key reject unsigned or invalid patches at boot and use a verifiable cached patch or base release. Adding/removing the signing requirement requires another release. Keep the private key outside source control. **Recommended gate:** require signing in the first FrockBot baseline and prove both acceptance and rejection on a device. This is separate from the existing Android APK signer. [Patch signing](https://docs.shorebird.dev/code-push/guides/patch-signing/)

Remote rollback is learned during the next update check and takes effect on the next start. Automatic local rollback covers hash/signature failure and a patch failing to load into the Dart runtime; the documentation does not promise recovery from arbitrary application logic bugs. A previous patch is retained through the next patch's successful boot. Downloading an older patch can consume quota; without remaining installs the app returns to its base release. **Inference:** remote rollback cannot reach an offline phone, and rolling code back must not be assumed to undo local data writes. [Rollback](https://docs.shorebird.dev/code-push/rollback/)

## Startup, offline use and account

The default updater checks on startup in a background thread without blocking the UI. Downloaded updates activate on restart. A failed network check is retried on a subsequent launch. Apps, including patched installs, continue functioning if the subscription is cancelled. Native plugins absent from the baseline cannot be safely introduced in a Dart patch. Shorebird supports stable Flutter releases only. [FAQ](https://docs.shorebird.dev/code-push/faq/)

A free Shorebird account, CLI authentication through `shorebird login`, and application initialization with `shorebird init` are documented setup steps. Initialization creates `shorebird.yaml` with a nonsecret application ID. The CLI brings a separate modified Flutter SDK. The local account is authenticated and the upload workflow is authorized; see the qualification ledger. [Quick Start](https://docs.shorebird.dev/getting-started/)

The pricing page currently lists Free at $0/month with 5,000 monthly patch installs, Pro at $20/month with 50,000, and Business at $400/month with 1,000,000. Pro/Business overages are listed at $1 per 2,500 installs. The retrieved comparison does not preserve its feature checkmarks, so this note does not assert which plan includes signing or rollback. Verify those entitlements before selecting a plan. [Pricing](https://shorebird.dev/pricing)

Billing documentation specifies successful patch installs, with skipped intermediate patches not separately charged, and optional overages disabled by default. The FAQ also contains active-user wording; use the dedicated billing terms and actual account console to settle any discrepancy before paid deployment. [Billing](https://docs.shorebird.dev/account/billing/)

## Acceptance checklist

- Build with Shorebird at the existing SDK pin and locked dependencies; preserve APK package, certificate and increasing full-release version.
- Test the baseline and a signed Dart-only staging patch on Android, including WebView, authentication, secure storage, conversation continuity and cold restart activation.
- Confirm offline launch before and after patching, interrupted download recovery, signature rejection and remote rollback with a second restart.
- Confirm that native/asset changes are rejected from the patch path, and a subsequent full APK upgrade preserves app data.
- Measure baseline versus patched launch/render performance and record the device, release and patch identifiers.

Refer to the qualification ledger for each observed result and the checks that remain unexercised. Preview is restricted to disposable emulators because it clears app data; phone upgrades use `adb install -r`.
