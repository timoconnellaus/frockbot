import Cocoa
import FlutterMacOS
import Sparkle

/// Sparkle with no windows of its own: every decision it would ask a person
/// about is answered by the Flutter control beside the profile, over
/// `com.frockbot/update` (see `lib/update/desktop_update.dart`).
///
/// A build without a feed URL and public key — every development build,
/// including `scripts/native-desktop-update.py` installs — never starts the
/// updater, so a local build is never replaced by the published release.
/// Sparkle calls its user driver on the main thread, as does the channel.
final class DesktopUpdater: NSObject, SPUUserDriver {
  static let shared = DesktopUpdater()

  private var channel: FlutterMethodChannel?
  private var updater: SPUUpdater?
  private var phase = "idle"
  private var version: String?
  private var downloaded = false
  private var received: UInt64 = 0
  private var expected: UInt64?
  private var message: String?

  /// Sparkle's open questions. Each is answered exactly once.
  private var pendingFound: ((SPUUserUpdateChoice) -> Void)?
  private var pendingReady: ((SPUUserUpdateChoice) -> Void)?
  private var retryTermination: (() -> Void)?

  /// Set by a press: the offer Sparkle is about to make is accepted at once.
  private var wantsDownload = false

  /// A check asked for while an older offer was open; it runs once Sparkle
  /// has closed that session, so the newest release replaces the old offer.
  private var recheck = false

  private var configured: Bool {
    let info = Bundle.main.infoDictionary ?? [:]
    let feed = (info["SUFeedURL"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    let key = (info["SUPublicEDKey"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    return URL(string: feed)?.scheme == "https" && !key.isEmpty
  }

  func bind(_ messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "com.frockbot/update", binaryMessenger: messenger)
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      switch call.method {
      case "state": result(self.snapshot)
      case "check":
        self.check()
        result(nil)
      case "download":
        self.download()
        result(nil)
      case "install": result(self.install())
      default: result(FlutterMethodNotImplemented)
      }
    }
    guard configured, updater == nil else { return }
    let updater = SPUUpdater(
      hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: nil)
    do {
      try updater.start()
      self.updater = updater
    } catch {
      publish("idle")
    }
  }

  private var snapshot: [String: Any] {
    var value: [String: Any] = [
      "phase": phase, "downloaded": downloaded, "received": Int(received),
    ]
    if let version { value["version"] = version }
    if let expected { value["expected"] = Int(expected) }
    if let message { value["message"] = message }
    return value
  }

  private func publish(_ next: String) {
    phase = next
    channel?.invokeMethod("state", arguments: snapshot)
  }

  private func check() {
    guard let updater else { return }
    // Only an offer still waiting on a press is replaced. A download already
    // under way finishes, and the relaunched app looks again.
    if let reply = pendingFound, !wantsDownload {
      pendingFound = nil
      recheck = true
      reply(.dismiss)
      return
    }
    if !updater.sessionInProgress { updater.checkForUpdatesInBackground() }
  }

  private func download() {
    guard let updater else { return }
    message = nil
    if let reply = pendingFound {
      pendingFound = nil
      reply(.install)
      return
    }
    wantsDownload = true
    if updater.sessionInProgress {
      recheck = true
    } else {
      updater.checkForUpdates()
    }
  }

  private func install() -> Bool {
    if let reply = pendingReady {
      pendingReady = nil
      publish("installing")
      reply(.install)
      return true
    }
    if let retry = retryTermination {
      retryTermination = nil
      publish("installing")
      retry()
      return true
    }
    return false
  }

  // MARK: SPUUserDriver

  func show(
    _ request: SPUUpdatePermissionRequest,
    reply: @escaping (SUUpdatePermissionResponse) -> Void
  ) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
  }

  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}

  func showUpdateFound(
    with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
    reply: @escaping (SPUUserUpdateChoice) -> Void
  ) {
    version = appcastItem.displayVersionString
    downloaded = state.stage != .notDownloaded
    received = 0
    expected = nil
    if wantsDownload {
      reply(.install)
      publish(downloaded ? "preparing" : "downloading")
      return
    }
    pendingFound = reply
    publish("available")
  }

  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}

  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

  func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
    acknowledgement()
    wantsDownload = false
    if !recheck { reset("idle") }
  }

  func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
    acknowledgement()
    message = error.localizedDescription
    wantsDownload = false
    pendingFound = nil
    pendingReady = nil
    publish("failed")
  }

  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    received = 0
    expected = nil
    publish("downloading")
  }

  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
    expected = expectedContentLength > 0 ? expectedContentLength : nil
    publish("downloading")
  }

  func showDownloadDidReceiveData(ofLength length: UInt64) {
    let before = percent
    received += length
    // One message per visible step, not one per network read.
    if expected == nil || percent != before { publish("downloading") }
  }

  private var percent: UInt64? {
    guard let expected, expected > 0 else { return nil }
    return min(received, expected) * 100 / expected
  }

  func showDownloadDidStartExtractingUpdate() {
    publish("preparing")
  }

  func showExtractionReceivedProgress(_ progress: Double) {}

  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
    wantsDownload = false
    downloaded = true
    pendingReady = reply
    publish("ready")
  }

  func showInstallingUpdate(
    withApplicationTerminated applicationTerminated: Bool,
    retryTerminatingApplication: @escaping () -> Void
  ) {
    if applicationTerminated { return }
    // Something refused to let the app quit. It keeps running; a press retries.
    retryTermination = retryTerminatingApplication
    publish("ready")
  }

  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    acknowledgement()
  }

  func showUpdateInstallationDidFinish(acknowledgement: @escaping () -> Void) {
    acknowledgement()
  }

  func showUpdateInFocus() {}

  func dismissUserInitiatedUpdateCheck() {}

  func dismissUpdateInstallation() {
    pendingFound = nil
    pendingReady = nil
    if recheck, let updater {
      recheck = false
      // Sparkle closes the session after this returns.
      DispatchQueue.main.async {
        if self.wantsDownload { updater.checkForUpdates() } else { updater.checkForUpdatesInBackground() }
      }
      return
    }
    if phase != "failed" && phase != "installing" && retryTermination == nil { reset("idle") }
  }

  private func reset(_ next: String) {
    version = nil
    downloaded = false
    received = 0
    expected = nil
    publish(next)
  }
}
