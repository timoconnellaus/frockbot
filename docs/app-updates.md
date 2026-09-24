# Application updates

How an installed FrockBot client becomes the current one, on every platform.
macOS is built. The other platforms are the plan, and this document is where
that plan lives until it is built.

The cloud is authoritative, so an old client is a compatibility problem, not a
data problem: the server's protocol range
(`core/protocol-schemas/compatibility.generated.ts`) decides what may still
connect. Every client names the release tag it was built from, but that is
information, never a gate. Updates exist to keep clients inside that range without anyone
reinstalling by hand.

## The shape every platform shares

- **One control, one press.** The update affordance is small and in the
  app's own chrome — beside the profile button on desktop, the ready header on
  a phone. It never blocks the app. What’s New never opens itself after an
  update: the megaphone beside the profile button wears the unread mark until
  it is opened.
- **Observable states.** `available → downloading (percent) → preparing →
restarting`, with `retry` from any failure and `restart to update` when an
  update is already staged. A platform that cannot report a state does not
  pretend to: the state is skipped, not faked.
- **Checkpoint before exit.** Local state (drafts, the plain store) is
  committed before the process is allowed to end. A checkpoint that fails
  cancels the restart and keeps the update staged.
- **Newest only.** A client offered several releases takes the newest one it
  can run. Feeds name one release; nothing is queued, and an offer still
  waiting on a press is replaced when a newer release appears.
- **Failures are ordinary.** A network drop, a bad signature or a refused
  restart leaves the running app exactly as it was and offers the press again.

In Dart the seam is `DesktopUpdater` (`apps/native/lib/update/desktop_update.dart`):
`check`, `download`, `install`, and a stream of snapshots. The controller above
it owns the states, the checkpoint and the retry rules, and is tested against a
fake. A new platform adds an adapter, not a new controller.

## macOS — Sparkle 2 (built)

Direct distribution, Developer ID signed and notarized. Sparkle 2 runs with a
custom user driver that shows nothing itself and reports to Flutter over
`com.frockbot/update`.

- **Artifact.** The same notarized, stapled `FrockBot-macos-<version>.dmg` the
  website serves, at its immutable R2 key. No second package is built.
- **Signatures.** Sparkle checks the EdDSA signature in the feed against
  `SUPublicEDKey` baked into the app, and that the new bundle carries the same
  Developer ID signature as the running one. Both must pass.
- **Feeds.** `mac/appcast.xml` (stable) and `mac/appcast-staging.xml`
  (prereleases). A prerelease build follows staging; a release build follows
  stable. `scripts/mac-appcast.py` writes one item, refuses to move a feed to an
  older build, and a tag writes only the feed its own channel owns.
- **Version identity.** `sparkle:version` is `CFBundleVersion`, the release
  run number, which only grows. `sparkle:shortVersionString` is the tag.
- **Development installs.** `scripts/native-desktop-update.py` builds without
  a feed URL or key, so Sparkle never starts and never replaces a local build.
  That build is a separate app, FrockBot Dev (`com.frockbot.mobile.dev`,
  scheme `frockbot-dev`), so Launch Services never opens it in place of the
  released app, which would then never see an update.
- **Symbols.** The archive build strips the executable. Rive Native is a
  static library whose C entry points Dart looks up by name at runtime, so
  `apps/native/macos/Runner/Configs/Release.xcconfig` keeps global symbols
  (`STRIP_STYLE = non-global`) and the release job fails if `makeRenderer` is
  missing from either architecture. v0.7.87 shipped without them and every Bot
  avatar surface drew Flutter's grey error box; `flutter build` and the Dev
  build never strip, so only the notarized release showed it.
- **Limits.** Sparkle cannot downgrade. Download progress is real; the brief
  install between quit and relaunch is not observable from inside the app.

## Android — Shorebird patches plus Google Play flexible updates (planned)

- **Dart-only changes** keep shipping as Shorebird patches
  (`scripts/native-update.py`): downloaded in the background, applied on the
  next engine start. The existing ready header is the restart affordance.
- **Full releases** (native code, plugins, assets, engine) go through Google
  Play's in-app update API with the **flexible** flow: Play downloads while the
  app runs and reports bytes downloaded, so the control can show a real
  percentage; on `DOWNLOADED` the control offers restart, the app checkpoints,
  then calls `completeUpdate()`, which installs and restarts the app.
- **Immediate** Play updates are used only when the installed build speaks a
  protocol below `protocolMin` and its grace period has ended.
- **Ordering.** A patch targets exactly one release baseline, so a patch is
  published only after its release is live on Play for that track; a new full
  release supersedes outstanding patches.

## iOS — Shorebird patches plus App Store updates (planned)

- **Dart-only changes** ship as Shorebird patches, applied on the next engine
  start, with the same ready header.
- **Full releases** go through the App Store. The app can learn that a newer
  version exists (from the store lookup or its own compatibility response) and
  send the person to the App Store page. **iOS does not let an app install a
  full update itself: there is no in-app download progress, and the app cannot
  restart itself into the new version.** The control shows "available" and
  opens the store; it has no downloading, preparing or restarting states for
  a full update.
- Rollout uses App Store phased release; TestFlight is the staging track.
- Where this stands: the Runner (`apps/native/ios`) configures the engine
  restart a patch applies through (`RestartAppPlugin.configureEngineRestart`
  in `AppDelegate.swift`, for the implicit engine's plugins and the app's own
  channels alike). No iOS release or patch has been cut, the new-engine path
  is unqualified, and `scripts/native-update.py` is Android-only.

## Windows — Velopack (planned)

- **Velopack** packages the app, publishes full and delta packages with a
  release feed, and exposes download progress and `ApplyUpdatesAndRestart`,
  which maps directly onto the shared states. The feed carries only the newest
  release per channel; Velopack applies deltas or falls back to the full
  package, so no intermediate release is installed.
- Channels map to `stable` and `staging` exactly as the Mac feeds do.
- Packages are Authenticode-signed; the app verifies the release feed over
  HTTPS from the same R2 bucket.
- **Alternative: MSIX with App Installer.** An `.appinstaller` file gives
  automatic background updates with OS-managed signing and rollback, but the
  app sees no progress and cannot choose the restart moment. Prefer it only if
  a Store or enterprise deployment requires MSIX.

## Release policy

**Order.** A client release is never offered before the backend it needs is
in production. In `release.yml`: verify → production deploys → build and
notarize → archive the artifact under its immutable key → move the website
download pointer → publish the in-app feed last. A failure at any step leaves
the previous feed, and so every installed app, unchanged.

**The simple profile ships the web client only.** `release.yml` attaches the
Flutter web bundle to the Release ([ADR 0028](adr/0028-open-deployment.md)).
It also attaches `frockbot.apk`, the hosted phone app, for sideloading from
that Release. The APK has the hosted origin baked in, so a self-hoster who
wants the phone app builds it against their own origin, and the update
control never appears.

**Staging then stable.** Prerelease tags publish only to staging feeds and
tracks (Mac `appcast-staging.xml`, Shorebird staging, Play internal testing,
TestFlight, Velopack `staging`). A release tag publishes stable. Where the
store supports it — Play staged rollout, App Store phased release — stable
reaches users in stages; Sparkle's `sparkle:phasedRolloutInterval` is available
if the Mac needs the same.

**Latest-version coalescing.** Every feed names only the newest release for
its channel. Clients check on start and on returning to the foreground; an
open offer is replaced by a newer one, and a download in progress finishes
first and the relaunched app looks again.

**Signatures.** Every update is verified twice, by the platform's code
signature (Developer ID, Play app signing, App Store, Authenticode) and by an
update-channel signature (Sparkle EdDSA, Shorebird patch signing, Velopack
feed over HTTPS). Private keys live only in repository secrets and an offline
backup; the public halves are compiled into the app.

**Rollback.** Installed clients do not downgrade. A bad release is rolled
_forward_: revert the change and ship a new, higher build through the same
pipeline, which every client then coalesces to. Before clients have taken the
bad release, withdraw its feed item or halt the store's staged rollout while
the fixed forward build is prepared; never relabel an older artifact with a
newer build number. A bad Shorebird patch is rolled back in the Shorebird
console, which returns patched clients to the release's own code.

**Protocol floor and grace period.** Raising `protocolMin` is a release
decision, not a side effect. The server announces the new protocol by raising
`protocolMax` at least one stable release before raising `protocolMin`, and old
clients keep working for a grace period (default 14 days) during which the
update control is shown and Sparkle's `sparkle:criticalUpdate` (or Play's
immediate flow) may be used. After the grace period the server refuses the old
protocol with a message that names the update path; an updated client keeps its
sign-in. Before any floor is enforced, the update control must also be
reachable from that refusal and from sign-in — today the Mac control lives in
the signed-in sidebar only — so an unsupported client can always reach a
supported one.
