// What the User Durable Object keeps for signing in to MCP servers, beside
// the credential store and never in it: a sign-in that is still in the
// person's browser, and the refresh side of a finished one.
//
// Both are sealed with the credential keyring under a context of their own —
// the server's Connection id with a suffix, which no credential generation
// ever carries — so neither can be leased, and a Turn never holds either. The
// only thing a Turn leases for a signed-in server is its access token.
import {
  decodeCredentialEnvelopeV1,
  type CredentialEnvelopeV1,
} from "@frockbot/core/connection";
import type { CredentialUserBackendContribution } from "@frockbot/app/credentials/user";
import { MCP_PACKAGE_ID } from "./definition.js";
import {
  decodeMcpSignInAttemptSecretV1,
  decodeMcpSignInGrantV1,
  type McpSignInAttemptSecretV1,
  type McpSignInGrantV1,
} from "./oauth.js";

const ATTEMPT_PREFIX = "mcp:sign-in:v1:";
const GRANT_PREFIX = "mcp:grant:v1:";

type Sealer = Pick<
  CredentialUserBackendContribution,
  "prepareApiKey" | "openPreparedSecret"
>;

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** One sign-in in the browser. `exchanging` is the claim on its code. */
export interface StoredMcpSignInV1 {
  schemaVersion: 1;
  accountId: string;
  connectionId: string;
  attemptId: string;
  status: "waiting" | "exchanging";
  expiresAt: number;
  redirectUri: string;
  /** The signed state's digest: a callback must bring back exactly it. */
  stateDigest: string;
  envelope: CredentialEnvelopeV1;
}

interface StoredMcpGrantV1 {
  schemaVersion: 1;
  accountId: string;
  connectionId: string;
  generation: string;
  envelope: CredentialEnvelopeV1;
}

function context(accountId: string, connectionId: string, kind: string) {
  return {
    accountId,
    connectionId: `${connectionId}/${kind}`,
    packageId: MCP_PACKAGE_ID,
  };
}

function decodeSignIn(value: unknown): StoredMcpSignInV1 | undefined {
  const stored = value as Partial<StoredMcpSignInV1> | undefined;
  if (
    stored?.schemaVersion !== 1 ||
    typeof stored.accountId !== "string" ||
    typeof stored.connectionId !== "string" ||
    typeof stored.attemptId !== "string" ||
    (stored.status !== "waiting" && stored.status !== "exchanging") ||
    !Number.isFinite(stored.expiresAt) ||
    typeof stored.redirectUri !== "string" ||
    typeof stored.stateDigest !== "string"
  ) {
    return undefined;
  }
  return {
    ...stored,
    envelope: decodeCredentialEnvelopeV1(stored.envelope),
  } as StoredMcpSignInV1;
}

export async function readMcpSignInV1(
  storage: Pick<Storage, "get">,
  connectionId: string,
): Promise<StoredMcpSignInV1 | undefined> {
  return decodeSignIn(
    await storage.get<unknown>(`${ATTEMPT_PREFIX}${connectionId}`),
  );
}

export async function writeMcpSignInV1(
  storage: Pick<Storage, "put">,
  sealer: Sealer,
  input: Omit<StoredMcpSignInV1, "schemaVersion" | "envelope" | "status"> & {
    secret: McpSignInAttemptSecretV1;
  },
): Promise<void> {
  const { secret, ...record } = input;
  const prepared = await sealer.prepareApiKey({
    ...context(input.accountId, input.connectionId, "sign-in"),
    generation: input.attemptId,
    apiKey: JSON.stringify(secret),
  });
  await storage.put<StoredMcpSignInV1>(
    `${ATTEMPT_PREFIX}${input.connectionId}`,
    {
      schemaVersion: 1,
      ...record,
      status: "waiting",
      envelope: prepared.envelope,
    },
  );
}

export async function markMcpSignInExchangingV1(
  storage: Pick<Storage, "put">,
  signIn: StoredMcpSignInV1,
): Promise<void> {
  await storage.put<StoredMcpSignInV1>(
    `${ATTEMPT_PREFIX}${signIn.connectionId}`,
    { ...signIn, status: "exchanging" },
  );
}

export async function openMcpSignInV1(
  sealer: Sealer,
  signIn: StoredMcpSignInV1,
): Promise<McpSignInAttemptSecretV1> {
  return decodeMcpSignInAttemptSecretV1(
    await sealer.openPreparedSecret({
      ...context(signIn.accountId, signIn.connectionId, "sign-in"),
      generation: signIn.attemptId,
      envelope: signIn.envelope,
    }),
  );
}

export async function forgetMcpSignInV1(
  storage: Pick<Storage, "delete">,
  connectionId: string,
): Promise<void> {
  await storage.delete(`${ATTEMPT_PREFIX}${connectionId}`);
}

/** Seals a grant for writing in the same transaction as its credential. */
export async function sealMcpGrantV1(
  sealer: Sealer,
  input: {
    accountId: string;
    connectionId: string;
    generation: string;
    grant: McpSignInGrantV1;
  },
): Promise<{ key: string; value: StoredMcpGrantV1 }> {
  const prepared = await sealer.prepareApiKey({
    ...context(input.accountId, input.connectionId, "grant"),
    generation: input.generation,
    apiKey: JSON.stringify(input.grant),
  });
  return {
    key: `${GRANT_PREFIX}${input.connectionId}`,
    value: {
      schemaVersion: 1,
      accountId: input.accountId,
      connectionId: input.connectionId,
      generation: input.generation,
      envelope: prepared.envelope,
    },
  };
}

/**
 * A server's grant, when the one kept is for this account and generation.
 * A grant kept for an earlier generation is what a new sign-in superseded.
 */
export async function readMcpGrantV1(
  storage: Pick<Storage, "get">,
  sealer: Sealer,
  input: { accountId: string; connectionId: string; generation?: string },
): Promise<(McpSignInGrantV1 & { generation: string }) | undefined> {
  const stored = await storage.get<StoredMcpGrantV1>(
    `${GRANT_PREFIX}${input.connectionId}`,
  );
  if (
    stored?.schemaVersion !== 1 ||
    stored.accountId !== input.accountId ||
    stored.connectionId !== input.connectionId ||
    (input.generation !== undefined && stored.generation !== input.generation)
  ) {
    return undefined;
  }
  const grant = decodeMcpSignInGrantV1(
    await sealer.openPreparedSecret({
      ...context(input.accountId, input.connectionId, "grant"),
      generation: stored.generation,
      envelope: decodeCredentialEnvelopeV1(stored.envelope),
    }),
  );
  return { ...grant, generation: stored.generation };
}

export async function forgetMcpGrantV1(
  storage: Pick<Storage, "delete">,
  connectionId: string,
): Promise<void> {
  await storage.delete(`${GRANT_PREFIX}${connectionId}`);
}
