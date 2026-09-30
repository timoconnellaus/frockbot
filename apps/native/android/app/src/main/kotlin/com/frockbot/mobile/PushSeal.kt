package com.frockbot.mobile

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Opens what a server that sends through the push relay sealed to this app:
 * RFC 8291 message encryption, `aes128gcm`, one record. A port of `openPushV1`
 * in `core/push/seal.ts`; the relay and Google carry only the ciphertext.
 *
 * Plain JVM on purpose, so its test runs without a device, and with its own
 * base64url because `java.util.Base64` needs API 26.
 */
object PushSeal {
    /** The key pair and auth secret an account's server seals to. */
    class Keys(val privateKey: ByteArray, val p256dh: String, val auth: String)

    fun generate(): Keys {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        val auth = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        return Keys(pair.private.encoded, encode(raw(pair.public as ECPublicKey)), encode(auth))
    }

    /** The plaintext, or an exception for anything that is not a sealed body for this key. */
    fun open(privateKey: ByteArray, p256dh: String, auth: String, sealed: String): String {
        val body = decode(sealed)
        require(body.size >= HEADER + 17 && body[20].toInt() == 65) { "Invalid sealed push" }
        val salt = body.copyOfRange(0, 16)
        val senderRaw = body.copyOfRange(21, HEADER)
        val receiverRaw = decode(p256dh)
        val receiver = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(privateKey)) as ECPrivateKey
        val sender = publicKey(senderRaw, receiver.params)
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(receiver)
        agreement.doPhase(sender, true)
        val ecdh = agreement.generateSecret()
        val ikm = hkdf(decode(auth), ecdh, "WebPush: info\u0000".toByteArray() + receiverRaw + senderRaw, 32)
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(), 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val record = cipher.doFinal(body, HEADER, body.size - HEADER)
        var end = record.size - 1
        while (end >= 0 && record[end].toInt() == 0) end--
        require(end >= 0 && record[end].toInt() == 2) { "Invalid sealed push" }
        return String(record, 0, end, Charsets.UTF_8)
    }

    private const val HEADER = 16 + 4 + 1 + 65
    private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)

    private fun raw(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

    private fun fixed(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        return when {
            bytes.size == 32 -> bytes
            bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
            else -> ByteArray(32 - bytes.size) + bytes
        }
    }

    /** The sender's key, refused unless it is a point on P-256 (RFC 8291 §7). */
    private fun publicKey(raw: ByteArray, params: ECParameterSpec): java.security.PublicKey {
        require(raw.size == 65 && raw[0].toInt() == 4) { "Invalid sender key" }
        val x = BigInteger(1, raw.copyOfRange(1, 33))
        val y = BigInteger(1, raw.copyOfRange(33, 65))
        require(x < P && y < P) { "Invalid sender key" }
        val lhs = y.modPow(BigInteger.valueOf(2), P)
        val rhs = x.modPow(BigInteger.valueOf(3), P).subtract(x.multiply(BigInteger.valueOf(3))).add(B).mod(P)
        require(lhs == rhs) { "Invalid sender key" }
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }

    private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = extract.doFinal(ikm)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(prk, "HmacSHA256"))
        return expand.doFinal(info + byteArrayOf(1)).copyOf(length)
    }

    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder()
        var i = 0
        while (i < bytes.size) {
            val n = minOf(3, bytes.size - i)
            var chunk = 0
            for (j in 0 until 3) chunk = (chunk shl 8) or (if (j < n) bytes[i + j].toInt() and 0xff else 0)
            for (j in 0..n) out.append(ALPHABET[(chunk shr (18 - 6 * j)) and 0x3f])
            i += 3
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        for (c in text) {
            val value = ALPHABET.indexOf(c)
            require(value >= 0) { "Invalid base64url" }
            buffer = (buffer shl 6) or value
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}
