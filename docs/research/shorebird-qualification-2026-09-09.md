# Shorebird Android qualification

Signed Android patch delivery, offline cold start and remote rollback passed on the ARM64 emulator. This qualifies the update mechanism, not every native feature or physical-phone performance budget. The phone receives a separate production baseline built from the reviewed release.

## Toolchain and identity

- Shorebird CLI 1.6.120 (`5ac7f9a9a5c4a5e66a958e608da0f73e34a3d6bb`).
- Shorebird Flutter 3.47.0, Dart 3.13.0, framework `cac7b89dba52c1b8086d211de9a86ad2219ea8ac`, engine `5a91274d10582c35d6df695511e327879664e35c`. Stock Flutter remains the development/web toolchain; its revisions intentionally differ.
- Locked dependency resolution and analysis passed. The qualification snapshot passed 274 app tests and 236 shared protocol fixture tests. An initially missing fixture directory was supplied before rerunning that test file.
- Qualification app `f8009352-78da-45c9-8467-78e424174de6`; production app `fab29f02-321e-4be1-b478-68dff4398073`.
- Uploaded qualification release `1.1.0+1788941465`, package `com.frockbot.mobile`, Android ARM64, minSdk 24, targetSdk 36.
- APK signer SHA-256 `61e6479f9c5755154c1f939cde48e8a757eff3136e54ed1dda5f61e78b3c1e37` matches the existing install. A separate RSA key signs patches. Its public key was verified in the APK's embedded `patch_public_key` as base64 PKCS#1 DER.

Tim explicitly authorized the compiled release and test-patch uploads after the initial automatic approval review required that authorization. Private signing keys remain outside source control.

## Observed behavior

| Check                 | Evidence                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabling APK upgrade  | `adb install -r` upgraded emulator version 47; the saved session remained present across two starts. This proves storage presence, not a backend conversation round trip.                                                                                                                         |
| Signed patch          | Patch 1, published to staging, downloaded 9,057 bytes. The next cold start reported a valid signature and ran the patch-specific startup marker.                                                                                                                                                  |
| Storage continuity    | The same nonsecret persistent sentinel appeared before and after the OTA patch and rollback.                                                                                                                                                                                                      |
| Offline cold start    | With Android reporting `Active default network: none`, the network request failed but the verified cached patch launched and retained the sentinel. Radios were restored.                                                                                                                         |
| Remote rollback       | An online check learned `rolled_back_patch_numbers: [1]`; the following cold start reported no active patch and ran the baseline marker, retaining the sentinel.                                                                                                                                  |
| Incorrect signing key | A second patch built with a different private key and the original public key failed with `Signature verification failed. The signature does not match the provided public key.` No second patch was uploaded. This tests CLI rejection; invalid downloaded code was not injected into the cache. |

The staging test used `shorebird preview` on a disposable emulator. **Preview clears application data unconditionally. Never use it on Tim's phone.** That reset removed the emulator's earlier saved session; subsequent OTA continuity concerns a newly created sentinel. Do not report authenticated-session continuity across preview. The physical phone was not touched by preview.

## Release constraints

Dart-only changes may be patched. Native code, engine, permissions, native dependencies and bundled assets require a new APK baseline. Do not override Shorebird's native/asset difference checks. Validate staging on a disposable device before promoting the exact patch to stable. Background downloads activate on a later cold start; rollback also requires a check and subsequent cold start.

Every patch supplies the baseline's exact release version, explicit build name and build number, target architecture, original public key and matching private key. Its Gradle version floor is baseline code minus one. A full release instead advances the installed/published APK version. APK publication metadata remains separate from patch identity.

The CLI rejects a source `channel` field in `shorebird.yaml`. Preview selects a track in its test artifact; do not copy that field into source configuration. Production uses stable with automatic updates.

Run Flutter tests and builds sequentially per checkout: tests can regenerate plugin registration during a release build. Android command-line tools/`apkanalyzer` are required; their absence caused a misleading debug-symbol stripping failure. Google's checksum-verified command-line tools resolved it. The successful build still warned about missing Dart crash symbols for Play Console, an outstanding diagnostics concern for Play distribution.

Interrupted-download recovery and malicious cache injection were not exercised. Emulator launch times are not physical-phone performance qualification. Unrelated gaps in `apps/native/qualification.json` remain unchanged.

Raw evidence is under ignored `.native-build/shorebird-qualification/`: SDK manifests, analysis/test logs, release logs, `preview.log`, `patch1.log`, `patch-bad-signature.log`, and rollback response. Do not publish credentials or private keys. The production publisher records the exact served APK hash, independently of the qualification dry-run artifact.
