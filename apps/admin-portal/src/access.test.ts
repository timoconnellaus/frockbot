import { beforeEach, describe, expect, test } from "bun:test";
import {
  accessTeamHostV1,
  accessTokenFromRequestV1,
  isPortalAdminV1,
  resetAccessKeyCacheV1,
  verifyAccessTokenV1,
} from "./access.js";
import { accessTeamFixtureV1 } from "./access-fixture.js";

const team = await accessTeamFixtureV1();
const configuration = { teamDomain: team.teamDomain, audience: team.audience };

beforeEach(() => {
  resetAccessKeyCacheV1();
});

function request(headers: Record<string, string>): Request {
  return new Request("https://admin.frockbot.com/", { headers });
}

describe("the assertion on the request", () => {
  test("is the header when Access set one, and the cookie otherwise", () => {
    expect(
      accessTokenFromRequestV1(
        request({ "cf-access-jwt-assertion": " header.token.value " }),
      ),
    ).toBe("header.token.value");
    expect(
      accessTokenFromRequestV1(
        request({ cookie: "other=1; CF_Authorization=cookie.token.value" }),
      ),
    ).toBe("cookie.token.value");
    // A cookie whose name only contains ours is not ours.
    expect(
      accessTokenFromRequestV1(
        request({ cookie: "NOT_CF_Authorization=nope" }),
      ),
    ).toBeUndefined();
    expect(accessTokenFromRequestV1(request({}))).toBeUndefined();
  });
});

describe("verifying one Access assertion", () => {
  test("accepts a token this team signed for this application", async () => {
    const verified = await verifyAccessTokenV1(
      await team.sign(),
      configuration,
      {
        fetchKeys: team.serveKeys(),
      },
    );

    expect(verified).toEqual({
      ok: true,
      identity: { email: "owner@example.com", subject: "access-user-1" },
    });
  });

  test("accepts a single-string audience and lower-cases the email", async () => {
    const verified = await verifyAccessTokenV1(
      await team.sign({ aud: team.audience, email: "Owner@Example.COM" }),
      configuration,
      { fetchKeys: team.serveKeys() },
    );

    expect(verified).toMatchObject({
      ok: true,
      identity: { email: "owner@example.com" },
    });
  });

  test("refuses another application's audience", async () => {
    expect(
      await verifyAccessTokenV1(
        await team.sign({ aud: ["b".repeat(64)] }),
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "wrong-audience" });
  });

  test("refuses another team's issuer", async () => {
    expect(
      await verifyAccessTokenV1(
        await team.sign({ iss: "https://someone-else.cloudflareaccess.com" }),
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "wrong-issuer" });
  });

  test("refuses an expired token, and one from the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      await verifyAccessTokenV1(
        await team.sign({ exp: now - 1 }),
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      await verifyAccessTokenV1(
        await team.sign({ nbf: now + 600 }),
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  test("refuses a signature from a key this team never published", async () => {
    expect(
      await verifyAccessTokenV1(
        await team.signWithStrangerKey(),
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses a tampered payload under a real signature", async () => {
    const token = await team.sign();
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = btoa(
      JSON.stringify({
        aud: [team.audience],
        iss: `https://${team.teamDomain}`,
        email: "attacker@example.com",
        exp: Math.floor(Date.now() / 1000) + 3_600,
      }),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

    expect(
      await verifyAccessTokenV1(
        `${header}.${forged}.${signature}`,
        configuration,
        { fetchKeys: team.serveKeys() },
      ),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("refuses an unsigned or differently signed token without reading keys", async () => {
    const keys = team.serveKeys();
    expect(
      await verifyAccessTokenV1(
        await team.sign({ header: { alg: "none" } }),
        configuration,
        { fetchKeys: keys },
      ),
    ).toEqual({ ok: false, reason: "unsupported-algorithm" });
    expect(
      await verifyAccessTokenV1("not.a.jwt.at.all", configuration, {
        fetchKeys: keys,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      await verifyAccessTokenV1("header.payload.signature", configuration, {
        fetchKeys: keys,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(keys.calls()).toBe(0);
  });

  test("refuses a token that names nobody", async () => {
    expect(
      await verifyAccessTokenV1(await team.sign({ email: "" }), configuration, {
        fetchKeys: team.serveKeys(),
      }),
    ).toEqual({ ok: false, reason: "no-email" });
  });

  test("refuses when the key set cannot be read at all", async () => {
    expect(
      await verifyAccessTokenV1(await team.sign(), configuration, {
        fetchKeys: () => Promise.reject(new Error("network is down")),
      }),
    ).toEqual({ ok: false, reason: "keys-unavailable" });
  });

  test("reads the key set once for repeated tokens, and again for a new key id", async () => {
    const keys = team.serveKeys();
    await verifyAccessTokenV1(await team.sign(), configuration, {
      fetchKeys: keys,
    });
    await verifyAccessTokenV1(await team.sign(), configuration, {
      fetchKeys: keys,
    });
    expect(keys.calls()).toBe(1);

    // A rotation: the cached set does not name this key, so it is read again
    // before the request is refused.
    expect(
      await verifyAccessTokenV1(
        await team.sign({ header: { kid: "key-2" } }),
        configuration,
        { fetchKeys: keys },
      ),
    ).toEqual({ ok: false, reason: "unknown-key" });
    expect(keys.calls()).toBe(2);
  });

  test("the team domain is the host, however the variable spells it", () => {
    expect(accessTeamHostV1(" https://Frockbot.cloudflareaccess.com/ ")).toBe(
      "frockbot.cloudflareaccess.com",
    );
  });
});

describe("who administers", () => {
  test("is exactly the configured list, compared trimmed and lower-cased", () => {
    const configured = " Owner@Example.com , second@example.com ";
    expect(isPortalAdminV1("owner@example.com", configured)).toBe(true);
    expect(isPortalAdminV1(" SECOND@example.com ", configured)).toBe(true);
    expect(isPortalAdminV1("stranger@example.com", configured)).toBe(false);
  });

  test("is nobody when the deployment names nobody", () => {
    expect(isPortalAdminV1("owner@example.com", undefined)).toBe(false);
    expect(isPortalAdminV1("owner@example.com", "")).toBe(false);
    expect(isPortalAdminV1("owner@example.com", " , ")).toBe(false);
  });
});
