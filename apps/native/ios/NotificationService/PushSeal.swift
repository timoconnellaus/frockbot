import CryptoKit
import Foundation

/// Opens what a server that sends through the push relay sealed to this app:
/// RFC 8291 message encryption, `aes128gcm`, one record. A port of
/// `openPushV1` in `core/push/seal.ts`, and of Android's `PushSeal.kt`.
enum PushSeal {
  enum Failure: Error { case invalid }

  private static let header = 16 + 4 + 1 + 65

  static func open(_ sealed: String, with keys: PushKeychain.Keys) throws -> String {
    guard let body = Data(base64url: sealed), body.count >= header + 17, body[body.startIndex + 20] == 65
    else { throw Failure.invalid }
    let bytes = [UInt8](body)
    let salt = Data(bytes[0..<16])
    let senderRaw = Data(bytes[21..<header])
    // CryptoKit refuses a point that is not on P-256 (RFC 8291 §7).
    let sender = try P256.KeyAgreement.PublicKey(x963Representation: senderRaw)
    let receiverRaw = keys.privateKey.publicKey.x963Representation
    let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: sender)
    let ikm = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: keys.auth,
      sharedInfo: Data("WebPush: info\0".utf8) + receiverRaw + senderRaw, outputByteCount: 32)
    let cek = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: aes128gcm\0".utf8),
      outputByteCount: 16)
    let nonce = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: salt, info: Data("Content-Encoding: nonce\0".utf8),
      outputByteCount: 12
    ).withUnsafeBytes { Data($0) }
    let ciphertext = Data(bytes[header...])
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext.dropLast(16),
      tag: ciphertext.suffix(16))
    let record = [UInt8](try AES.GCM.open(box, using: cek))
    var end = record.count - 1
    while end >= 0 && record[end] == 0 { end -= 1 }
    guard end >= 0, record[end] == 2, let text = String(bytes: record[0..<end], encoding: .utf8)
    else { throw Failure.invalid }
    return text
  }
}
