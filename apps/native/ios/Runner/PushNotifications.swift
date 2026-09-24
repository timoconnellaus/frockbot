import FirebaseCore
import FirebaseMessaging
import Flutter
import UIKit
import UserNotifications
import app_links

/// FCM on an iPhone, over the channel Android's `PushNotifications.kt` answers.
///
/// Android draws its own notification from a data message. An iPhone app is
/// suspended when a message lands, so the cloud sends an iPhone its alert as an
/// APNs alert (`apps/cloudflare/src/push.ts`) and iOS draws it, one thread per
/// conversation. What stays here is what Android's does besides drawing: the
/// account the alerts belong to, the read cursor that takes a delivered alert
/// away, the link a tap opens, and telling Dart that activity arrived.
final class PushNotifications: NSObject, MessagingDelegate {
  static let shared = PushNotifications()
  private var channel: FlutterMethodChannel?
  private var configured = false
  /// `configure` calls waiting for APNs, by the attempt that is timing them.
  private var pending: [UUID: FlutterResult] = [:]
  private let store = UserDefaults.standard

  private override init() {
    super.init()
    let center = NotificationCenter.default
    _ = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.channel?.invokeMethod("focus", arguments: true) }
    _ = center.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.channel?.invokeMethod("focus", arguments: false) }
  }

  /// The newest engine's channel; an engine a patch restarted out of hears nothing more.
  func bind(_ messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "frockbot/push", binaryMessenger: messenger)
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { return }
      let args = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "configure":
        self.configure(
          userId: args["userId"] as? String, origin: args["origin"] as? String, result: result)
      case "permission":
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) {
          _, _ in
        }
        result(nil)
      case "focus":
        result(UIApplication.shared.applicationState == .active)
      case "read":
        if let bot = args["botId"] as? String, let cursor = args["cursor"] as? String {
          self.read(bot, cursor)
        }
        result(nil)
      case "logout":
        self.account(nil, origin: nil)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func configure(userId: String?, origin: String?, result: @escaping FlutterResult) {
    account(userId, origin: origin)
    // Only the released identity carries a Firebase registration, and
    // configuring Firebase without one throws.
    guard Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil else {
      result(FlutterError(code: "unconfigured", message: "Firebase is not configured", details: nil))
      return
    }
    if !configured {
      FirebaseApp.configure()
      Messaging.messaging().delegate = self
      configured = true
    }
    if Messaging.messaging().apnsToken != nil, let token = Messaging.messaging().fcmToken {
      result(token)
      return
    }
    let attempt = UUID()
    pending[attempt] = result
    UIApplication.shared.registerForRemoteNotifications()
    // APNs may never answer — no network, no push entitlement — and Dart
    // waits on this before it registers the device's presence.
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
      guard let result = self?.pending.removeValue(forKey: attempt) else { return }
      result(PushNotifications.unavailable)
    }
  }

  /// APNs's token for this installation, which FCM exchanges for its own.
  func registered(_ deviceToken: Data) {
    guard configured else { return }
    Messaging.messaging().apnsToken = deviceToken
    Messaging.messaging().token { [weak self] token, _ in
      DispatchQueue.main.async {
        if let token { self?.finish(token) } else { self?.failed() }
      }
    }
  }

  func failed() { finish(PushNotifications.unavailable) }

  private static let unavailable = FlutterError(
    code: "token", message: "Push registration unavailable", details: nil)

  private func finish(_ value: Any) {
    let waiting = pending.values
    pending.removeAll()
    for result in waiting { result(value) }
  }

  /// A rotated token replaces this installation's; Dart registers it.
  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let fcmToken else { return }
    DispatchQueue.main.async { self.channel?.invokeMethod("token", arguments: fcmToken) }
  }

  /// Everything held for one account. Another account's sign-in, or a
  /// sign-out, drops it with the alerts it drew.
  private func account(_ userId: String?, origin: String?) {
    if store.string(forKey: "push.userId") != userId {
      UNUserNotificationCenter.current().removeAllDeliveredNotifications()
      for key in store.dictionaryRepresentation().keys where key.hasPrefix("push.") {
        store.removeObject(forKey: key)
      }
      store.set(userId, forKey: "push.userId")
    }
    if let origin { store.set(origin, forKey: "push.origin") }
  }

  /// A read on any device takes the alerts it covers away from this one.
  private func read(_ botId: String, _ cursor: String) {
    let key = "push.read.\(botId)"
    guard cursor > (store.string(forKey: key) ?? "") else { return }
    store.set(cursor, forKey: key)
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let covered = delivered.filter { note in
        let info = note.request.content.userInfo
        return info["groupId"] == nil && info["botId"] as? String == botId
          && (info["cursor"] as? String ?? "") <= cursor
      }
      center.removeDeliveredNotifications(withIdentifiers: covered.map { $0.request.identifier })
    }
  }

  /// A push iOS woke the app for. Any alert in it iOS has drawn already.
  func receive(_ info: [AnyHashable: Any]) {
    guard let message = message(info) else { return }
    if message.kind == "read" { read(message.botId, message.cursor) }
    channel?.invokeMethod("activity", arguments: nil)
  }

  /// An alert arriving while the app is open. Only the persisted read cursor
  /// discards it, as on Android: local focus is a lease the server already
  /// honours by holding delivery back, and a stale one here would lose a
  /// message that did arrive.
  func presentation(_ info: [AnyHashable: Any]) -> UNNotificationPresentationOptions {
    guard let message = message(info) else { return [] }
    channel?.invokeMethod("activity", arguments: nil)
    let key = message.groupId.map { "group:\($0)" } ?? message.botId
    if message.cursor <= (store.string(forKey: "push.read.\(key)") ?? "") { return [] }
    return [.banner, .list, .sound]
  }

  /// A tapped alert opens its conversation through the same link Android's
  /// notification carries, on the deployment this build talks to.
  func open(_ info: [AnyHashable: Any]) {
    guard let message = message(info),
          let origin = store.string(forKey: "push.origin"),
          var link = URLComponents(string: origin)
    else { return }
    link.path = "/"
    link.queryItems = [
      message.groupId.map { URLQueryItem(name: "group", value: $0) }
        ?? URLQueryItem(name: "bot", value: message.botId)
    ]
    guard let url = link.url else { return }
    AppLinks.shared.handleLink(url: url)
  }

  private struct Message {
    let botId: String
    let groupId: String?
    let cursor: String
    let kind: String?
  }

  /// This account's message, or nothing: an alert for another account, or
  /// one whose cursor or group is not one the cloud writes, is not followed.
  private func message(_ info: [AnyHashable: Any]) -> Message? {
    guard let user = info["userId"] as? String, user == store.string(forKey: "push.userId"),
          let botId = info["botId"] as? String,
          let cursor = info["cursor"] as? String,
          cursor.range(of: "^message-[0-9]{20}$", options: .regularExpression) != nil
    else { return nil }
    let groupId = info["groupId"] as? String
    if let groupId, groupId.range(of: "^g-[0-9a-f]{20}$", options: .regularExpression) == nil {
      return nil
    }
    return Message(botId: botId, groupId: groupId, cursor: cursor, kind: info["kind"] as? String)
  }
}
