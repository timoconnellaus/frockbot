import { beforeAll, describe, expect, test } from "bun:test";
import {
  accessKeysV1,
  accessLogoutUrlV1,
  teamOriginV1,
  verifyAccessTokenV1,
} from "./token.ts";
import {
  ACCESS_AUTH_PACKAGE_V1,
  accessTokenOfV1,
  accessUserIdV1,
  createAccessPackageV1,
} from "./index.ts";

const TEAM_DOMAIN = "frockbot-test.cloudflareaccess.com";
const AUDIENCE = "a".repeat(64);
const KID = "test-key-1";
const NOW = Date.parse("2026-09-15T00:00:00Z");

let signingKey: CryptoKey;
let jwks: { keys: unknown[] };
let otherSigningKey: CryptoKey;

async function rsaPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  const pair = await rsaPair();
  signingKey = pair.privateKey;
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwks = { keys: [{ ...publicKey, kid: KID, alg: "RS256", use: "sig" }] };
  otherSigningKey = (await rsaPair()).privateKey;
});

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function token(
  claims: Record<string, unknown> = {},
  overrides: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        alg: overrides.alg ?? "RS256",
        kid: overrides.kid ?? KID,
        typ: "JWT",
      }),
    ),
  );
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: AUDIENCE,
        iss: `https://${TEAM_DOMAIN}`,
        sub: "identity-1",
        email: "person@example.com",
        exp: Math.floor(NOW / 1000) + 600,
        ...claims,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    overrides.key ?? signingKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function keys(onFetch?: () => void) {
  return accessKeysV1({
    teamDomain: TEAM_DOMAIN,
    now: () => NOW,
    fetcher: (async (url: string) => {
      onFetch?.();
      expect(url).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
      return Response.json(jwks);
    }) as unknown as typeof fetch,
  });
}

function verify(value: string) {
  return verifyAccessTokenV1(value, {
    keys: keys(),
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    now: () => NOW,
  });
}

describe("an Access application token", () => {
  test("is accepted when the team signed it for this application", async () => {
    expect(await verify(await token())).toEqual({
      subject: "identity-1",
      email: "person@example.com",
      expiresAt: (Math.floor(NOW / 1000) + 600) * 1000,
    });
  });

  test("is refused when it names another application", async () => {
    // The whole point of the audience check: every application in a team is
    // signed by the same keys, so without it any of them opens this one.
    await expect(verify(await token({ aud: "b".repeat(64) }))).rejects.toThrow(
      "another Access application",
    );
    // Including when the claim is a list that does not contain ours.
    await expect(
      verify(await token({ aud: ["b".repeat(64)] })),
    ).rejects.toThrow("another Access application");
  });

  test("is refused when it has expired", async () => {
    await expect(
      verify(await token({ exp: Math.floor(NOW / 1000) - 1 })),
    ).rejects.toThrow("expired");
  });

  test("is refused when another team issued it", async () => {
    await expect(
      verify(await token({ iss: "https://someone-else.cloudflareaccess.com" })),
    ).rejects.toThrow("another Access team");
  });

  test("is refused when the signature is not the team's", async () => {
    await expect(
      verify(await token({}, { key: otherSigningKey })),
    ).rejects.toThrow("signature does not verify");
  });

  test("is refused when it is not a signed JWT at all", async () => {
    const valid = await token();
    await expect(verify("not-a-token")).rejects.toThrow("not a JWT");
    await expect(verify(`${valid}.extra`)).rejects.toThrow("not a JWT");
    // `alg: none` with a signature nobody checked is the classic forgery.
    await expect(verify(await token({}, { alg: "none" }))).rejects.toThrow(
      "token algorithm none",
    );
    await expect(
      verify(await token({}, { kid: "rotated-away" })),
    ).rejects.toThrow("unknown key");
  });

  test("is refused when it carries no identity", async () => {
    await expect(verify(await token({ sub: "" }))).rejects.toThrow(
      "names no identity",
    );
    await expect(verify(await token({ email: "  " }))).rejects.toThrow(
      "carries no email",
    );
  });

  test("costs one certs fetch for many verifications", async () => {
    let fetches = 0;
    const held = keys(() => {
      fetches += 1;
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await verifyAccessTokenV1(await token(), {
        keys: held,
        teamDomain: TEAM_DOMAIN,
        audience: AUDIENCE,
        now: () => NOW,
      });
    }
    expect(fetches).toBe(1);
  });
});

describe("the Access team's addresses", () => {
  test("are built from the domain however it was written", () => {
    expect(teamOriginV1(` ${TEAM_DOMAIN}/ `)).toBe(`https://${TEAM_DOMAIN}`);
    expect(teamOriginV1(`https://${TEAM_DOMAIN}`)).toBe(
      `https://${TEAM_DOMAIN}`,
    );
    expect(accessLogoutUrlV1(TEAM_DOMAIN)).toBe(
      `https://${TEAM_DOMAIN}/cdn-cgi/access/logout`,
    );
  });
});

describe("the Access auth Package", () => {
  const configured = () =>
    createAccessPackageV1(
      { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE },
      { keys: keys(), now: () => NOW },
    );

  test("reads the token from the header or the cookie", async () => {
    const value = await token();
    expect(
      accessTokenOfV1(new Headers({ "cf-access-jwt-assertion": value })),
    ).toBe(value);
    expect(
      accessTokenOfV1(
        new Headers({ cookie: `other=1; CF_Authorization=${value}` }),
      ),
    ).toBe(value);
    expect(accessTokenOfV1(new Headers({ cookie: "other=1" }))).toBeUndefined();
  });

  test("resolves the same User id for the same identity, and no other", async () => {
    const identity = await configured().getSession(
      new Headers({ "cf-access-jwt-assertion": await token() }),
    );
    expect(identity).toEqual({
      user: {
        id: await accessUserIdV1("identity-1"),
        email: "person@example.com",
        emailVerified: true,
      },
    });
    expect(identity!.user.id).toMatch(/^access-[0-9a-f]{32}$/);
    expect(await accessUserIdV1("identity-2")).not.toBe(identity!.user.id);
  });

  test("answers nobody for a request Access did not sign", async () => {
    expect(await configured().getSession(new Headers())).toBeNull();
    expect(
      await configured().getSession(
        new Headers({
          "cf-access-jwt-assertion": await token({}, { key: otherSigningKey }),
        }),
      ),
    ).toBeNull();
  });

  test("signs out through the team's logout, and serves no sign-in route", async () => {
    const request = new Request("https://bot.example/sign-out");
    const response = await configured().signOut(request, new URL(request.url));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `https://${TEAM_DOMAIN}/cdn-cgi/access/logout`,
    );
    expect((await configured().handler(request)).status).toBe(404);
    expect((await configured().startSignIn(request, "/")).status).toBe(401);
  });

  test("refuses everything until the deployment names its team and audience", async () => {
    const stub = createAccessPackageV1({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN });
    expect(await stub.getSession(new Headers())).toBeNull();
    expect(
      (await stub.handler(new Request("https://bot.example/"))).status,
    ).toBe(503);
  });
});

describe("the Access build", () => {
  const build = ACCESS_AUTH_PACKAGE_V1.create({
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
  });

  test("stores no identity, so there is none to look up or list", () => {
    // Which is why the operator surface lists no accounts on this build and
    // refuses its one write: there is no stored email to check an admin against.
    expect(build.storedIdentity).toBeUndefined();
    expect(build.listStoredIdentities).toBeUndefined();
  });

  test("signs the native door with a key of its own", () => {
    expect(ACCESS_AUTH_PACKAGE_V1.nativeTokenSecret.name).toBe(
      "NATIVE_TOKEN_SECRET",
    );
    expect(
      ACCESS_AUTH_PACKAGE_V1.nativeTokenSecret.read({
        NATIVE_TOKEN_SECRET: "minted",
      }),
    ).toBe("minted");
    // Never the hosted key: this build has none, and rotating that one would
    // revoke every native session on frockbot.com.
    expect(
      ACCESS_AUTH_PACKAGE_V1.required.map((setting) => setting.name),
    ).not.toContain("BETTER_AUTH_SECRET");
  });

  test("the policy is the allowlist, so there is no authority to ask", () => {
    expect(ACCESS_AUTH_PACKAGE_V1.admission).toBe("package");
  });
});
