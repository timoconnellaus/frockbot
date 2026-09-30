import UserNotifications

/// Draws what a relayed alert says. A server that sends through the push
/// relay seals the words (`apps/push-relay`), so APNs is handed a placeholder
/// with `mutable-content`, and this replaces it with what it opens with the
/// account's key. An alert it cannot open keeps the placeholder; one from a
/// server that sends to FCM itself carries its words already and is left be.
final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    handler = contentHandler
    self.content = content
    if let sealed = content.userInfo["sealed"] as? String,
       let keys = PushKeychain.load(),
       let text = try? PushSeal.open(sealed, with: keys),
       let words = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    {
      if let title = words["title"] as? String, !title.isEmpty { content.title = title }
      if let body = words["body"] as? String, !body.isEmpty { content.body = body }
    }
    contentHandler(content)
    handler = nil
  }

  override func serviceExtensionTimeWillExpire() {
    if let handler, let content { handler(content) }
    handler = nil
  }
}
