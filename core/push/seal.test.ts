import { describe, expect, test } from "bun:test";
import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";
import { isPushKeyV1, openPushV1, sealPushV1 } from "./seal.js";

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  senderPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function keyPair(privateKey: string, publicKey: string) {
  const point = base64urlDecodeV1(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKey,
    x: base64urlEncodeV1(point.slice(1, 33)),
    y: base64urlEncodeV1(point.slice(33, 65)),
  };
  return {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    publicKey: await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    ),
  } satisfies CryptoKeyPair;
}

const receiverKey = { p256dh: RFC.receiverPublic, auth: RFC.auth };

describe("push sealing", () => {
  test("seals the RFC 8291 example byte for byte", async () => {
    expect(
      await sealPushV1(receiverKey, RFC.plaintext, {
        sender: await keyPair(RFC.senderPrivate, RFC.senderPublic),
        salt: base64urlDecodeV1(RFC.salt),
      }),
    ).toBe(RFC.body);
  });

  test("opens the RFC 8291 example and its own output", async () => {
    const receiver = {
      privateKey: (await keyPair(RFC.receiverPrivate, RFC.receiverPublic))
        .privateKey,
      key: receiverKey,
    };
    expect(await openPushV1(receiver, RFC.body)).toBe(RFC.plaintext);
    const text = JSON.stringify({ title: "Primary", body: "Héllo 👋" });
    const sealed = await sealPushV1(receiverKey, text);
    expect(sealed).not.toContain("Primary");
    expect(await openPushV1(receiver, sealed)).toBe(text);
  });

  test("refuses a tampered body and a key it cannot seal to", async () => {
    const receiver = {
      privateKey: (await keyPair(RFC.receiverPrivate, RFC.receiverPublic))
        .privateKey,
      key: receiverKey,
    };
    const tampered =
      RFC.body.slice(0, -2) + (RFC.body.endsWith("fN") ? "fM" : "fN");
    await expect(openPushV1(receiver, tampered)).rejects.toThrow();
    expect(isPushKeyV1(receiverKey)).toBe(true);
    for (const invalid of [
      null,
      { p256dh: RFC.receiverPublic },
      { p256dh: RFC.auth, auth: RFC.auth },
      { p256dh: RFC.receiverPublic, auth: RFC.receiverPublic },
      { ...receiverKey, extra: "x" },
    ])
      expect(isPushKeyV1(invalid)).toBe(false);
    await expect(sealPushV1(receiverKey, "x".repeat(4000))).rejects.toThrow(
      /too long/,
    );
  });
});
