import { expect, spyOn, test } from "bun:test";
import {
  createGoogleIdTokenVerifier,
  HOSTED_AUTH_TRUSTED_ORIGINS,
} from "./auth.ts";

test("hosted auth trusts no legacy local mobile origin", () => {
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).toEqual(["com.frockbot.desktop:/"]);
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).not.toContain("capacitor://localhost");
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).not.toContain("frockbot://localhost");
});

function base64Url(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64url");
}

async function signedGoogleToken(
  privateKey: CryptoKey,
  audience: string,
  issuer = "https://accounts.google.com",
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key" }));
  const payload = base64Url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: "google-user",
      iat: now,
      exp: now + 600,
      nonce: "native-nonce",
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

test("Google ID token verification binds issuer, nonce, and Web client audience", async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const mockedFetch: typeof fetch = Object.assign(
    () =>
      Promise.resolve(
        Response.json({
          keys: [
            {
              ...publicJwk,
              alg: "RS256",
              kid: "test-key",
              use: "sig",
            },
          ],
        }),
      ),
    { preconnect() {} },
  );
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);

  try {
    const expectedAudience = "web-client.apps.googleusercontent.com";
    const validToken = await signedGoogleToken(
      keys.privateKey,
      expectedAudience,
    );
    const wrongAudienceToken = await signedGoogleToken(
      keys.privateKey,
      "other.apps.googleusercontent.com",
    );
    const wrongIssuerToken = await signedGoogleToken(
      keys.privateKey,
      expectedAudience,
      "https://attacker.example",
    );
    const verify = createGoogleIdTokenVerifier(expectedAudience);

    expect(await verify(validToken, "native-nonce")).toBe(true);
    expect(await verify(validToken, "different-nonce")).toBe(false);
    expect(await verify(wrongAudienceToken, "native-nonce")).toBe(false);
    expect(await verify(wrongIssuerToken, "native-nonce")).toBe(false);
  } finally {
    fetchMock.mockRestore();
  }
});
