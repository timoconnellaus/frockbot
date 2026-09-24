// The `state` a sign-in to an MCP server carries through the person's browser
// and back: whose sign-in it is, for which server, which attempt, and until
// when. It is signed where the attempt is started, with a key derived from
// the credential keyring, so the public callback can refuse a forged or stale
// one before it addresses any Durable Object — an anonymous redirect must not
// choose which object is woken.
//
// The signature proves only that FrockBot minted the value. The User Durable
// Object still holds the attempt, and a callback is honoured once, for the
// attempt it names, with the verifier only that object has.
import {
  deriveKeyringSigningKeyV1,
  parseCredentialKeyringV1,
} from "@frockbot/core/connection";
import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";

const PURPOSE = "frockbot mcp-oauth state v1";
/** Longer than any state this module mints; anything past it is not one. */
const MAX_STATE_LENGTH = 1_024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface McpOAuthStateV1 {
  userId: string;
  connectionId: string;
  attemptId: string;
  /** Epoch milliseconds after which the callback refuses it. */
  expiresAt: number;
}

interface SignedPayload {
  v: 1;
  k: string;
  u: string;
  c: string;
  a: string;
  x: number;
}

const encoder = new TextEncoder();

export async function signMcpOAuthStateV1(
  keyring: string,
  state: McpOAuthStateV1,
): Promise<string> {
  const parsed = parseCredentialKeyringV1(keyring);
  for (const value of [state.userId, state.connectionId, state.attemptId]) {
    if (!IDENTIFIER.test(value)) throw new Error("Sign-in state is invalid");
  }
  const payload: SignedPayload = {
    v: 1,
    k: parsed.currentKeyId,
    u: state.userId,
    c: state.connectionId,
    a: state.attemptId,
    x: state.expiresAt,
  };
  const body = base64urlEncodeV1(encoder.encode(JSON.stringify(payload)));
  const key = await deriveKeyringSigningKeyV1({
    keyring: parsed,
    keyId: parsed.currentKeyId,
    purpose: PURPOSE,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );
  return `${body}.${base64urlEncodeV1(signature)}`;
}

/**
 * The state a callback carried, when FrockBot signed it and it has not
 * expired; otherwise nothing, whatever was wrong with it.
 */
export async function verifyMcpOAuthStateV1(
  keyring: string,
  value: unknown,
  now: number,
): Promise<McpOAuthStateV1 | undefined> {
  if (typeof value !== "string" || value.length > MAX_STATE_LENGTH) {
    return undefined;
  }
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return undefined;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecodeV1(body)),
    ) as Partial<SignedPayload>;
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).sort().join(",") !== "a,c,k,u,v,x" ||
      payload.v !== 1 ||
      typeof payload.k !== "string" ||
      typeof payload.u !== "string" ||
      typeof payload.c !== "string" ||
      typeof payload.a !== "string" ||
      !Number.isSafeInteger(payload.x) ||
      ![payload.u, payload.c, payload.a].every((id) => IDENTIFIER.test(id))
    ) {
      return undefined;
    }
    const key = await deriveKeyringSigningKeyV1({
      keyring: parseCredentialKeyringV1(keyring),
      keyId: payload.k,
      purpose: PURPOSE,
    });
    // `verify` compares in constant time; a hand-rolled `===` would not.
    const genuine = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecodeV1(signature) as Uint8Array<ArrayBuffer>,
      encoder.encode(body),
    );
    if (!genuine || (payload.x as number) <= now) return undefined;
    return {
      userId: payload.u,
      connectionId: payload.c,
      attemptId: payload.a,
      expiresAt: payload.x as number,
    };
  } catch {
    return undefined;
  }
}
