# FrockBot for Mac — direct distribution

The main Flutter Mac app is distributed from frockbot.com, signed with Developer
ID and notarized by Apple. It is not submitted to the Mac App Store. Messages
runs inside this app; there is no separately installed companion. The phone and
web clients remain remote clients and never access the Mac's Messages database.

## Messages setup

In **Registered machines → Messages on this Mac**, read and accept the cloud/AI
sharing disclosure, then click **Connect this Mac**. Enable **Messages on your
Mac** in Connectors as well. Requested messages, contacts and attachments can be
shared with FrockBot's cloud and the AI providers used by your Bots.

For reading, add **FrockBot** to Full Disk Access and restart it. For sending,
click **Allow Messages sending** to request Automation permission. Each send
requires approval of its recipient and exact text in FrockBot. No permission
prompt can be initiated by a remote Bot. Keep the app open and the Mac awake.

Withdrawing local consent, signing out or quitting stops the bridge. Revoking a
machine invalidates its token server-side; **Forget pairing** removes the local
Keychain entry. Revocation does not delete content already shared. Consent and
Keychain enrollment are scoped to the deployment and signed-in FrockBot account.

## Implementation

`Runner/AppDelegate.swift` owns Keychain, local consent and Apple Events, behind
a narrow Flutter method channel. `lib/machines/mac_messages.dart` renders the
controls using the existing app theme. The bundled `apps/mac-messages` helper
reuses the durable poll/claim/report loop, advertises only `messages`, and exposes
no local HTTP server, general shell access or arbitrary file access.

A local SQLite send ledger commits each command's intent before Apple Events and
its result afterward. A replay returns the saved result. After an ambiguous
crash it reports an unknown outcome without sending again. The ledger contains
no credentials and remains after unpairing. Enrollment lives only in Keychain.
Attachments must resolve within Messages' attachment directory.

## Build and qualification

Use the pinned Flutter and Bun versions. Run `bun run typecheck`, `bun test`,
`python3 scripts/mac-release-test.py`, and the Flutter analysis/test suite.

```sh
python3 scripts/mac-release.py 1.1.0
```

This builds a universal Apple silicon/Intel app, bundles its universal Messages
helper and produces an ad-hoc-signed `FrockBot-macos-development.zip`. This is a
development artifact, not a public download. Tests use synthetic databases and
simulated sends; a live send requires a user-approved recipient and exact text.

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

The script signs nested frameworks, helper and app separately with hardened
runtime, checks notarization is **Accepted**, staples and validates its ticket,
and passes Gatekeeper assessment before producing `FrockBot-macos.zip`. Signing
failures must never result in an unsigned public release.

Push `mac-v1.1.0` on that same commit. The Mac release workflow qualifies the
universal app and creates a draft. Watch the tag to completion with
`bun scripts/ci-watch.ts`. Upload the verified ZIP to that draft, verify its
checksum and name, and publish it. Only once that asset is public does the
website gain a Mac download button, pointing at that explicit release so cloud
releases cannot accidentally replace it. That button lives in
`apps/marketing/public/index.html` and currently points at `mac-v1.1.0`; update
its link with each Mac release.
Cloud tags (`v*`) and Mac tags (`mac-v*`) ship independently; merging alone ships
neither.

Before calling a release ready, verify the installed signature, Gatekeeper,
associated-domain sign-in, pairing, consent withdrawal, restart recovery and
revocation. No production Messages history or real sends are needed for
automated tests. iPhone App Store submissions must disclose the Mac integration
and cloud/AI data flows, and provide App Review a way to inspect them. Direct Mac
notarization is not a promise of iPhone App Store approval.

Sources: [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/),
[Mac notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
