import Cocoa
import CryptoKit
import FlutterMacOS
import Security

/// The module host: `device-host.js` under the bundled Deno, which pairs this
/// Mac and runs the account's device modules while the app is open (ADR 0037).
///
/// The host speaks one JSON object per line over stdin and stdout. It holds no
/// secret of its own: the machine token rests in this app's Keychain, read and
/// written through `native` requests scoped to the signed-in account. Flutter
/// drives it over `com.frockbot/device-host` (see `lib/machines/device_host.dart`).
@MainActor
final class DeviceHostBridge {
  static let shared = DeviceHostBridge()

  private static let service = "com.frockbot.mobile.device-host"

  private var channel: FlutterMethodChannel?
  private var origin = ""
  private var userId = ""
  private var account: String { origin + ":" + userId }
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var buffer = Data()
  private var reader: Task<Void, Never>?
  private var chunkFeed: AsyncStream<Data>.Continuation?
  private var ready = false
  private var enrolled = false
  private var connected = false
  private var modules: [Any] = []
  private var error = ""

  private var deno: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/deno") }
  private var script: URL? { Bundle.main.url(forResource: "device-host", withExtension: "js") }
  private var runtime: URL? { Bundle.main.url(forResource: "device-runtime", withExtension: "js") }

  /// A development build run from Xcode or `flutter run` carries no Deno.
  private var available: Bool {
    FileManager.default.isExecutableFile(atPath: deno.path) && script != nil && runtime != nil
  }

  /// Set by Forget, so this Mac does not pair itself again until asked.
  private var declined: Bool {
    get { UserDefaults.standard.bool(forKey: "deviceHostDeclined:" + account) }
    set { UserDefaults.standard.set(newValue, forKey: "deviceHostDeclined:" + account) }
  }

  private var snapshot: [String: Any] {
    [
      "userId": userId, "origin": origin, "available": available,
      "running": process != nil, "ready": ready, "enrolled": enrolled,
      "connected": connected, "declined": !userId.isEmpty && declined,
      "modules": modules, "error": error,
    ]
  }

  private func publish() { channel?.invokeMethod("status", arguments: snapshot) }

  func bind(_ messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "com.frockbot/device-host", binaryMessenger: messenger)
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
          url.scheme == "https" || url.host == "127.0.0.1" || url.host == "localhost",
          url.host != nil, let user = args["userId"] as? String, !user.isEmpty
        else {
          result(
            FlutterError(
              code: "configuration", message: "Device modules need a signed-in account",
              details: nil))
          return
        }
        self.stop()
        self.origin = origin
        self.userId = user
        self.start()
      case "pair":
        self.declined = false
        self.error = ""
        self.send(["type": "pair", "code": args["code"] as? String ?? ""])
      case "forget":
        self.declined = true
        self.error = ""
        self.send(["type": "unpair"])
      case "stop":
        self.stop()
        self.origin = ""
        self.userId = ""
      case "status": break
      default:
        result(FlutterMethodNotImplemented)
        return
      }
      result(self.snapshot)
    }
  }

  private func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    do { try input?.write(contentsOf: data + Data([10])) } catch {
      self.error = "Device modules stopped. Reopen FrockBot to restart them."
      publish()
    }
  }

  /// The host's own directory, one per deployment and account.
  private func supportDirectory() throws -> URL {
    let digest = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("FrockBot/device-host/" + digest, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func start() {
    guard process == nil, !userId.isEmpty, available, let script, let runtime,
      let url = URL(string: origin), let host = url.host
    else {
      publish()
      return
    }
    let support: URL
    do { support = try supportDirectory() } catch {
      self.error = "Device modules could not create their folder."
      publish()
      return
    }
    let net = url.port.map { "\(host):\($0)" } ?? host
    let child = Process()
    child.executableURL = deno
    // Exactly what the host needs: the deployment, its own folder, and
    // `sandbox-exec` to start each module inside its Seatbelt profile. Deno's
    // `child_process` reads NODE_V8_COVERAGE as it spawns.
    child.arguments = [
      "run", "--no-prompt", "--no-config", "--no-remote", "--no-npm", "--cached-only",
      "--allow-net=\(net)",
      "--allow-read=\(support.path)",
      "--allow-write=\(support.path)",
      "--allow-run=/usr/bin/sandbox-exec",
      "--allow-env=NODE_V8_COVERAGE",
      script.path,
    ]
    child.environment = [
      "HOME": NSHomeDirectory(),
      "DENO_DIR": support.appendingPathComponent("deno").path,
      "DENO_NO_UPDATE_CHECK": "1",
      "NO_COLOR": "1",
    ]
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
        self.error = "Device modules stopped. Reopen FrockBot to restart them."
        self.publish()
      }
    }
    do {
      try child.run()
      process = child
      error = ""
      send([
        "type": "start", "origin": origin,
        "supportDir": support.path, "deno": deno.path, "runtime": runtime.path,
        "home": NSHomeDirectory(),
        "label": String((Host.current().localizedName ?? ProcessInfo.processInfo.hostName).prefix(64)),
        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0",
      ])
    } catch {
      stop()
      self.error = "Device modules could not start."
    }
    publish()
  }

  /// Closing the host's stdin stops it and every module it started.
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
    ready = false
    enrolled = false
    connected = false
    modules = []
    publish()
  }

  private func receive(_ data: Data) {
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
        ready = true
        enrolled = message["enrolled"] as? Bool ?? false
        connected = message["connected"] as? Bool ?? false
        modules = message["modules"] as? [Any] ?? []
        publish()
      case "error":
        error = message["message"] as? String ?? "Device modules hit an error."
        publish()
      default: break
      }
    }
  }

  private func native(_ request: [String: Any]) {
    guard let id = request["id"] as? Int, let method = request["method"] as? String else { return }
    var reply: [String: Any] = ["type": "reply", "id": id]
    switch method {
    case "read", "write", "clear":
      do {
        reply["value"] =
          try keychain(method, value: request["value"] as? String) ?? NSNull() as Any
      } catch {
        reply["error"] = "Keychain refused the request. Unlock your keychain and try again."
      }
    default:
      reply["error"] = "unknown request"
    }
    send(reply)
  }

  private func keychain(_ method: String, value: String? = nil) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service, kSecAttrAccount as String: account,
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
      guard let data = value?.data(using: .utf8) else { throw DeviceHostError.invalid }
      status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
      if status == errSecItemNotFound {
        var entry = query
        entry[kSecValueData as String] = data
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        status = SecItemAdd(entry as CFDictionary, nil)
      }
    }
    guard status == errSecSuccess else { throw DeviceHostError.keychain }
    return nil
  }

  private enum DeviceHostError: Error { case invalid, keychain }
}
