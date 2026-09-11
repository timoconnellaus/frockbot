import Carbon
import Cocoa
import FlutterMacOS
import Security
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
    MacMessagesBridge.shared.stop()
    super.applicationWillTerminate(notification)
  }
}

private let service = "com.frockbot.mobile.messages.enrollment"
func keychain(_ method: String, account: String, value: String? = nil) throws -> String? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: account,
  ]
  var status: OSStatus
  if method == "read" {
    var read = query
    read[kSecReturnData as String] = true
    read[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    status = SecItemCopyMatching(read as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    if status == errSecSuccess, let data = result as? Data {
      return String(data: data, encoding: .utf8)
    }
  } else if method == "clear" {
    status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { return nil }
  } else {
    guard let data = value?.data(using: .utf8) else { throw MacMessagesError.invalid }
    status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var entry = query
      entry[kSecValueData as String] = data
      entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      status = SecItemAdd(entry as CFDictionary, nil)
    }
  }
  guard status == errSecSuccess else { throw MacMessagesError.keychain }
  return nil
}
enum MacMessagesError: Error { case invalid, keychain, automation }

@MainActor
final class MacMessagesBridge {
  static let shared = MacMessagesBridge()
  private var channel: FlutterMethodChannel?
  private var origin = ""
  private var account = ""
  private var userId = ""
  private var consent = false { didSet { publish() } }
  private var paired = false { didSet { publish() } }
  private var busy = false { didSet { publish() } }
  private var status = "Stopped" { didSet { publish() } }
  private var error = "" { didSet { publish() } }
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private var reader: Task<Void, Never>?
  private var chunkFeed: AsyncStream<Data>.Continuation?

  private var snapshot: [String: Any] {
    [
      "userId": userId, "origin": origin, "consent": consent, "paired": paired, "busy": busy,
      "status": status, "error": error,
    ]
  }
  private func publish() { channel?.invokeMethod("status", arguments: snapshot) }
  func bind(_ messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "com.frockbot/messages", binaryMessenger: messenger)
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let args = call.arguments as? [String: Any] ?? [:]
      if call.method != "configure" && call.method != "status" {
        guard !self.userId.isEmpty, args["userId"] as? String == self.userId,
          args["origin"] as? String == self.origin
        else {
          result(
            FlutterError(
              code: "account-changed", message: "The signed-in account changed", details: nil))
          return
        }
      }
      switch call.method {
      case "configure":
        guard let origin = args["origin"] as? String, let url = URL(string: origin),
          url.scheme == "https", url.host != nil,
          let user = args["userId"] as? String, !user.isEmpty
        else {
          result(
            FlutterError(
              code: "configuration",
              message: "Messages requires a signed-in account and HTTPS deployment", details: nil))
          return
        }
        self.stop()
        self.origin = origin
        self.userId = user
        self.account = origin + ":" + user
        self.consent = UserDefaults.standard.bool(forKey: "messagesSharingConsent:" + self.account)
        self.start()
      case "consent": self.setConsent(args["allowed"] as? Bool == true)
      case "pair": self.pair(args["code"] as? String ?? "")
      case "forget": self.forget()
      case "automation": self.requestAutomation()
      case "disk-access":
        NSWorkspace.shared.open(
          URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
      case "stop":
        self.stop()
        self.account = ""
        self.origin = ""
        self.userId = ""
        self.consent = false
      case "status": break
      default:
        result(FlutterMethodNotImplemented)
        return
      }
      result(self.snapshot)
    }
  }
  func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    do { try input?.write(contentsOf: data + Data([10])) } catch {
      self.error = "The FrockBot stopped. Reopen it to reconnect."
      busy = false
    }
  }
  func start() {
    guard consent, process == nil else { return }
    error = ""
    guard !account.isEmpty else { return }
    let child = Process()
    child.executableURL = Bundle.main.bundleURL.appendingPathComponent(
      "Contents/Helpers/messages-agent")
    let incoming = Pipe()
    let outgoing = Pipe()
    child.standardInput = incoming
    child.standardOutput = outgoing
    child.standardError = FileHandle.nullDevice
    input = incoming.fileHandleForWriting
    output = outgoing.fileHandleForReading
    var made: AsyncStream<Data>.Continuation!
    let chunks = AsyncStream<Data> { made = $0 }
    let continuation: AsyncStream<Data>.Continuation = made
    chunkFeed = continuation
    output?.readabilityHandler = { handle in continuation.yield(handle.availableData) }
    reader = Task { @MainActor [weak self] in
      for await data in chunks {
        guard let self, self.process === child else { return }
        self.receive(data)
      }
    }
    child.terminationHandler = { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self, self.process === child else { return }
        self.stop()
        self.error = "The FrockBot stopped. Reopen it to reconnect."
      }
    }
    do {
      try child.run()
      process = child
      busy = true
      send([
        "type": "start", "origin": origin, "consent": true,
        "ledgerKey": account,
        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0",
      ])
    } catch {
      stop()
      self.error = "Could not start the FrockBot."
    }
  }
  func stop() {
    let child = process
    process = nil
    output?.readabilityHandler = nil
    chunkFeed?.finish()
    chunkFeed = nil
    reader?.cancel()
    reader = nil
    try? input?.close()
    try? output?.close()
    input = nil
    output = nil
    if child?.isRunning == true { child?.terminate() }
    buffer.removeAll()
    busy = false
    paired = false
    status = "Stopped"
  }
  func setConsent(_ allowed: Bool) {
    consent = allowed
    UserDefaults.standard.set(allowed, forKey: "messagesSharingConsent:" + account)
    if allowed { start() } else { stop() }
  }
  func pair(_ code: String) {
    guard consent, !busy, process != nil else { return }
    busy = true
    error = ""
    send(["type": "pair", "code": code])
  }
  func forget() {
    stop()
    do {
      _ = try keychain("clear", account: account)
      error = ""
      start()
    } catch {
      self.error = "Keychain could not remove the pairing. Unlock your keychain and try again."
    }
  }
  func receive(_ data: Data) {
    guard !data.isEmpty else { return }
    buffer.append(data)
    while let end = buffer.firstIndex(of: 10) {
      let line = buffer.prefix(upTo: end)
      buffer.removeSubrange(...end)
      guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
        continue
      }
      switch message["type"] as? String {
      case "native": native(message)
      case "status":
        if let state = message["status"] as? [String: Any] {
          paired = state["enrolled"] as? Bool ?? false
          status =
            !paired
            ? "Ready to pair"
            : (state["failures"] as? Int ?? 0) > 0
              ? "Reconnecting…" : "Paired · waiting for requests"
        }
      case "done": busy = false
      case "error":
        error = message["message"] as? String ?? "Request failed"
        busy = false
      default: break
      }
    }
  }
  func native(_ request: [String: Any]) {
    guard let id = request["id"] as? Int, let method = request["method"] as? String else { return }
    var reply: [String: Any] = ["type": "reply", "id": id]
    do {
      guard consent else { throw MacMessagesError.invalid }
      switch method {
      case "read", "write", "clear":
        reply["value"] =
          try keychain(method, account: account, value: request["value"] as? String) ?? NSNull()
          as Any
      case "permissions": reply["value"] = automationPermission(ask: false)
      case "send":
        guard automationPermission(ask: false), let source = request["value"] as? String else {
          throw MacMessagesError.automation
        }
        var details: NSDictionary?
        guard let script = NSAppleScript(source: source) else { throw MacMessagesError.invalid }
        script.executeAndReturnError(&details)
        if details != nil { throw MacMessagesError.automation }
        reply["value"] = true
      default: throw MacMessagesError.invalid
      }
    } catch {
      reply["error"] = "The Mac denied the request. Check Keychain and Messages permissions."
    }
    send(reply)
  }
  func automationPermission(ask: Bool) -> Bool {
    let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.iChat")
    return AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, ask)
      == noErr
  }
  func requestAutomation() {
    guard consent else { return }
    // Only a local button may cause an OS consent prompt.
    if automationPermission(ask: true) {
      error = ""
    } else {
      error =
        "Automation is unavailable. Open Messages, then allow FrockBot MacMessages in System Settings → Privacy & Security → Automation."
    }
  }
}
