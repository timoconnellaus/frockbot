import CryptoKit
import Foundation
import Security

/// The key a server that sends through the push relay seals this account's
/// alerts to (`core/push/seal.ts`), kept in the keychain group the app shares
/// with its Notification Service Extension, which opens them. Made once per
/// account; a sign-out or another account's sign-in deletes it.
enum PushKeychain {
  struct Keys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data
  }

  private static let service = "com.frockbot.push.relay"

  /// `$(AppIdentifierPrefix)<app id>.push`, written into both Info.plists.
  private static var group: String? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "FrockBotKeychainGroup") as? String,
          !group.isEmpty, !group.hasPrefix(".")
    else { return nil }
    return group
  }

  private static func query(grouped: Bool) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "relay",
    ]
    if grouped, let group { query[kSecAttrAccessGroup as String] = group }
    return query
  }

  static func load() -> Keys? {
    for grouped in [true, false] {
      var match = query(grouped: grouped)
      match[kSecReturnData as String] = true
      match[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      guard SecItemCopyMatching(match as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data, data.count == 48,
            let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32))
      else { continue }
      return Keys(privateKey: key, auth: Data(data.suffix(16)))
    }
    return nil
  }

  /// A new key for this account. The extension reads it while the phone is
  /// locked, so it is readable after the first unlock, and never leaves it.
  static func create() -> Keys? {
    delete()
    let keys = Keys(
      privateKey: P256.KeyAgreement.PrivateKey(),
      auth: Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
    var item = query(grouped: true)
    item[kSecValueData as String] = keys.privateKey.rawRepresentation + keys.auth
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    var status = SecItemAdd(item as CFDictionary, nil)
    // A build signed without the shared group (an unsigned or Dev build)
    // keeps the key to the app; its extension then draws the placeholder.
    if status == errSecMissingEntitlement {
      item.removeValue(forKey: kSecAttrAccessGroup as String)
      status = SecItemAdd(item as CFDictionary, nil)
    }
    return status == errSecSuccess ? keys : nil
  }

  static func delete() {
    SecItemDelete(query(grouped: true) as CFDictionary)
    SecItemDelete(query(grouped: false) as CFDictionary)
  }
}

extension Data {
  init?(base64url: String) {
    var text = base64url.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    text += String(repeating: "=", count: (4 - text.count % 4) % 4)
    self.init(base64Encoded: text)
  }

  var base64url: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}
