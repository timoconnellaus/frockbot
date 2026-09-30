package com.frockbot.mobile

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** RFC 8291 §5: what `core/push/seal.ts` seals, this opens. */
class PushSealTest {
    private val auth = "BTBZMqHH6r4Tts7J_aSIgg"
    private val p256dh = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
    private val body =
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"

    private fun receiverPrivateKey(): ByteArray {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val params = (generator.generateKeyPair().public as ECPublicKey).params
        val d = BigInteger(1, PushSeal.decode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, params)).encoded
    }

    @Test fun opensTheRfcExample() {
        assertEquals("When I grow up, I want to be a watermelon", PushSeal.open(receiverPrivateKey(), p256dh, auth, body))
    }

    @Test fun refusesATamperedBody() {
        val tampered = body.substring(0, body.length - 2) + "fM"
        assertThrows(Exception::class.java) { PushSeal.open(receiverPrivateKey(), p256dh, auth, tampered) }
    }

    @Test fun refusesASenderKeyOffTheCurve() {
        val bytes = PushSeal.decode(body)
        bytes[40] = (bytes[40].toInt() xor 1).toByte()
        assertThrows(IllegalArgumentException::class.java) {
            PushSeal.open(receiverPrivateKey(), p256dh, auth, PushSeal.encode(bytes))
        }
    }

    @Test fun generatesKeysOfTheShapeTheServerAccepts() {
        val keys = PushSeal.generate()
        assertEquals(65, PushSeal.decode(keys.p256dh).size)
        assertEquals(4, PushSeal.decode(keys.p256dh)[0].toInt())
        assertEquals(16, PushSeal.decode(keys.auth).size)
        assertEquals(keys.auth, PushSeal.encode(PushSeal.decode(keys.auth)))
    }
}
