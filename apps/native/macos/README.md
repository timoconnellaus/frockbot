# FrockBot for Mac — direct distribution

The main Flutter Mac app is distributed from frockbot.com, signed with Developer
ID and notarized by Apple. It is not submitted to the Mac App Store.

## Device modules

While the app is open and signed in, it runs the device modules of the Plugins
installed on the account
([ADR 0037](../../../docs/adr/0037-plugin-device-modules.md)).
`Runner/DeviceHostBridge.swift` starts the module host,
`Contents/Resources/device-host.js`, under the bundled `Contents/Helpers/deno`,
allowed to reach only the deployment, its own folder and `/usr/bin/sandbox-exec`.
The host pairs this Mac through the signed-in session the first time, keeps the
machine socket open, and starts each module in its own Deno process inside a
Seatbelt profile built from what the module declares (`apps/device-host`). A
build run from Xcode or `flutter run` carries no Deno and runs no modules.

The machine token rests in Keychain under `com.frockbot.mobile.device-host`, one
entry per deployment and account. Downloaded modules and each module's own store
live under `~/Library/Application Support/FrockBot/device-host/<account digest>/`.
Signing out or quitting stops the host and every module. **Forget** on **Your
computers → This Mac** removes the Keychain entry and keeps this Mac unpaired
until **Run modules on this Mac** is pressed; revoking the machine in the list
invalidates its token everywhere.

## Build and qualification

Use the pinned Flutter and Bun versions. Run `bun run typecheck`, `bun test`,
`python3 scripts/mac-release-test.py`, and the Flutter analysis/test suite.

```sh
python3 scripts/mac-release.py 1.1.0
```

This builds a universal Apple silicon/Intel app, bundles a universal Deno
(`scripts/fetch-deno.py`, checked by hash) and the module host, and produces an
ad-hoc-signed `FrockBot-macos-development.zip`. This is a development artifact,
not a public download.

## Signed release

Required locally:

- `MAC_DEVELOPER_ID`: complete **Developer ID Application** identity, including
  its private key in Keychain. An Apple Development or Apple Distribution
  certificate cannot replace it.
- `MAC_NOTARY_PROFILE`: notarization credentials saved using `xcrun notarytool
store-credentials`. Never put passwords in the repository or process arguments.
- `MAC_PROVISIONING_PROFILE`: Developer ID provisioning profile for
  `com.frockbot.mobile`, permitting `applinks:bot.frockbot.com`. The existing
  verified-link sign-in requires this profile; do not remove that gate to ship.

From the merged, tested commit:

```sh
python3 scripts/mac-release.py 1.1.0 --release
```

The script signs nested frameworks, Deno and the app separately with hardened
runtime, checks notarization is **Accepted**, staples and validates its ticket,
and passes Gatekeeper assessment, then packages the stapled app into a
Developer ID-signed `FrockBot-macos.dmg` with an Applications shortcut and
notarizes and staples the image too. Signing failures must never result in an
unsigned public release.

Push `mac-v1.1.0` on that same commit. The Mac release workflow qualifies the
universal app and creates a draft. Watch the tag to completion with
`bun scripts/ci-watch.ts`. Upload the verified DMG to that draft, verify its
checksum and name, and publish it. The website's "Download for Mac" button
points at `/download/mac`, which the marketing worker redirects to
`downloads.frockbot.com/mac/FrockBot-macos.dmg` — an R2 object the
`publish-download` job overwrites once a release has finished, after archiving
the same image under `mac/FrockBot-macos-<version>.dmg`. Visitors stay on our
own domain and never see the repository, and what they receive changes only
when a release completes, not when a GitHub Release is edited. A prerelease
tag is archived but leaves the pointer alone. No link edit is needed per
release.
Cloud tags (`v*`) and Mac tags (`mac-v*`) ship independently; merging alone ships
neither.

Before calling a release ready, verify the installed signature, Gatekeeper,
associated-domain sign-in and restart recovery. Direct Mac notarization is not a
promise of iPhone App Store approval.

Sources: [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/),
[Mac notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
