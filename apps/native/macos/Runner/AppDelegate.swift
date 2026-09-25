import Carbon
import Cocoa
import FlutterMacOS
import app_links

@main
class AppDelegate: FlutterAppDelegate {
  /// The copy of FrockBot that was already running when this process started.
  ///
  /// Launch Services opens a `frockbot://` link with whichever bundle it last
  /// registered for the scheme. That is not always the one running: a release
  /// build left in `build/` beside the installed app, or a debug build under
  /// `flutter run`, carries the same identifier and scheme. Opened that way,
  /// the browser's sign-in return launches a second copy of the app instead of
  /// reaching the first. A copy launched to open a link while another runs
  /// hands the link to the running copy, brings it forward and quits. A copy
  /// opened by hand beside a running one is what was asked for, and stays.
  private var primary: NSRunningApplication?
  private var forwarding = 0
  private var forwarded = false
  private var launched = false

  override func applicationWillFinishLaunching(_ notification: Notification) {
    super.applicationWillFinishLaunching(notification)
    guard let identifier = Bundle.main.bundleIdentifier else { return }
    let me = ProcessInfo.processInfo.processIdentifier
    primary = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
      .filter { $0.processIdentifier != me && !$0.isTerminated && $0.bundleURL != nil }
      .min { ($0.launchDate ?? .distantPast) < ($1.launchDate ?? .distantPast) }
    guard primary != nil else { return }
    // The link this copy was opened with arrives as an Apple Event between
    // here and the end of launching. The app_links plugin registered for it a
    // moment ago; this copy takes it over so the running copy receives it.
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(forward(_:with:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    super.applicationDidFinishLaunching(notification)
    guard primary != nil else { return }
    launched = true
    // A link still on its way in gets a moment to arrive. Without one this copy
    // was opened by hand: the plugin takes its handler back and it carries on.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self, self.primary != nil else { return }
      if self.forwarded {
        self.yield()
      } else {
        self.primary = nil
        AppLinks.shared.handleWillFinishLaunching(notification)
      }
    }
  }

  @objc private func forward(_ event: NSAppleEventDescriptor, with reply: NSAppleEventDescriptor) {
    guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
      let url = URL(string: text)
    else { return }
    forward(url)
  }

  private func forward(_ url: URL) {
    guard let bundle = primary?.bundleURL else { return }
    // Nothing of this copy should be seen: the window the nib opened goes away
    // before its first frame.
    for window in NSApp.windows { window.orderOut(nil) }
    forwarded = true
    forwarding += 1
    NSWorkspace.shared.open([url], withApplicationAt: bundle, configuration: .init()) {
      [weak self] _, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.forwarding -= 1
        self.yield()
      }
    }
  }

  private func yield() {
    guard launched, forwarded, forwarding == 0, let primary else { return }
    primary.activate(options: [.activateAllWindows])
    NSApp.terminate(nil)
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
  // A Universal Link arrives as a browsing activity, which the app_links plugin
  // cannot observe on its own; the custom scheme it handles itself.
  override func application(
    _ application: NSApplication, continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void
  ) -> Bool {
    guard let url = AppLinks.shared.getUniversalLink(userActivity) else { return false }
    if primary != nil {
      forward(url)
      return false
    }
    AppLinks.shared.handleLink(link: url.absoluteString)
    return false
  }
  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
  override func applicationWillTerminate(_ notification: Notification) {
    DeviceHostBridge.shared.stop()
    super.applicationWillTerminate(notification)
  }
}
