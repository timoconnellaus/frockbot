// A Cloudflare Access team, in memory: one RSA key pair, the key set it
// publishes, and tokens signed with it. Only the tests import this.

export interface AccessTeamFixtureV1 {
  teamDomain: string;
  audience: string;
  kid: string;
  /** The `/cdn-cgi/access/certs` document this team would serve. */
  keySet: { keys: unknown[] };
  /** A signed assertion; every claim is overridable. */
  sign(claims?: Record<string, unknown>): Promise<string>;
  /** Signed with a key this team never published. */
  signWithStrangerKey(claims?: Record<string, unknown>): Promise<string>;
  /** Serves `keySet`, and counts how many times it was asked. */
  serveKeys(): ((url: string) => Promise<Response>) & { calls: () => number };
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function encodeSegment(value: unknown): string {
  return base64Url(
    new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer,
  );
}

async function keyPair(): Promise<CryptoKeyPair> {
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

export async function accessTeamFixtureV1(
  options: {
    teamDomain?: string;
    audience?: string;
    kid?: string;
  } = {},
): Promise<AccessTeamFixtureV1> {
  const teamDomain = options.teamDomain ?? "frockbot.cloudflareaccess.com";
  const audience = options.audience ?? "a".repeat(64);
  const kid = options.kid ?? "key-1";
  const team = await keyPair();
  const stranger = await keyPair();
  const published = (await crypto.subtle.exportKey(
    "jwk",
    team.publicKey,
  )) as Record<string, unknown>;

  const token = async (
    signingKey: CryptoKey,
    claims: Record<string, unknown>,
    header: Record<string, unknown>,
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const body = encodeSegment({
      aud: [audience],
      iss: `https://${teamDomain}`,
      email: "owner@example.com",
      sub: "access-user-1",
      iat: now - 10,
      exp: now + 3_600,
      ...claims,
    });
    const head = encodeSegment({ alg: "RS256", kid, typ: "JWT", ...header });
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      signingKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${base64Url(signature)}`;
  };

  const keySet = {
    keys: [{ ...published, kid, alg: "RS256", use: "sig" }],
  };

  return {
    teamDomain,
    audience,
    kid,
    keySet,
    sign: (claims = {}) => {
      const { header, ...rest } = claims as {
        header?: Record<string, unknown>;
      };
      return token(team.privateKey, rest, header ?? {});
    },
    signWithStrangerKey: (claims = {}) =>
      token(stranger.privateKey, claims, {}),
    serveKeys() {
      let calls = 0;
      const serve = (url: string) => {
        calls += 1;
        if (!url.endsWith("/cdn-cgi/access/certs")) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(Response.json(keySet));
      };
      return Object.assign(serve, { calls: () => calls });
    },
  };
}
