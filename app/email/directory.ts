// The deployment's email usernames: which User each one belongs to.
//
// Email Routing hands every message for the deployment's domain to one
// handler, naming only the recipient, `<bot-slug>.<username>@<domain>`. A User
// Durable Object is addressed by User, so something deployment-wide has to
// answer "whose username is this?" first — and has to keep a username to one
// account. That is this directory, kept by the singleton `DeploymentPolicy`
// object inside one synchronous transaction per call, so two accounts
// claiming one name are serialized rather than reconciled. Which Bot a slug
// names is the User's own object's to say.

import { isEmailUsernameV1 } from "./shared.js";

/** The synchronous key-value half of SQLite-backed Durable Object storage. */
export interface EmailUsernameDirectoryKvV1 {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
}

const USERNAME_PREFIX = "email:username:v1:";
/** Each User's username the other way round, so a change can release it. */
const USER_PREFIX = "email:user:v1:";

interface StoredUsernameV1 {
  schemaVersion: 1;
  userId: string;
}

function storedUsername(value: unknown): StoredUsernameV1 | undefined {
  const held = value as StoredUsernameV1 | undefined;
  return held?.schemaVersion === 1 && typeof held.userId === "string"
    ? held
    : undefined;
}

export type EmailUsernameClaimV1 = { status: "claimed" } | { status: "taken" };

/**
 * This User's username is now `username`, unless another account holds it.
 * The one they held before is released in the same write; claiming the one
 * they hold already changes nothing.
 */
export function claimEmailUsernameV1(
  kv: EmailUsernameDirectoryKvV1,
  claim: { userId: string; username: string },
): EmailUsernameClaimV1 {
  if (!isEmailUsernameV1(claim.username)) {
    throw new Error("email username is invalid");
  }
  const holder = storedUsername(kv.get(USERNAME_PREFIX + claim.username));
  if (holder && holder.userId !== claim.userId) return { status: "taken" };
  releaseEmailUsernameV1(kv, claim.userId);
  kv.put(USERNAME_PREFIX + claim.username, {
    schemaVersion: 1,
    userId: claim.userId,
  } satisfies StoredUsernameV1);
  kv.put(USER_PREFIX + claim.userId, claim.username);
  return { status: "claimed" };
}

/**
 * This User has no username any more, and anyone may take the one they had.
 * Deleting an account ends here too.
 */
export function releaseEmailUsernameV1(
  kv: EmailUsernameDirectoryKvV1,
  userId: string,
): void {
  const username = kv.get<string>(USER_PREFIX + userId);
  if (typeof username === "string") {
    const holder = storedUsername(kv.get(USERNAME_PREFIX + username));
    if (holder?.userId === userId) kv.delete(USERNAME_PREFIX + username);
  }
  kv.delete(USER_PREFIX + userId);
}

/** The User a username belongs to, if anyone's. */
export function resolveEmailUsernameV1(
  kv: EmailUsernameDirectoryKvV1,
  username: string,
): string | undefined {
  return storedUsername(kv.get(USERNAME_PREFIX + username))?.userId;
}

/** A User's username, if they chose one. */
export function readEmailUsernameV1(
  kv: EmailUsernameDirectoryKvV1,
  userId: string,
): string | undefined {
  const username = kv.get<string>(USER_PREFIX + userId);
  return typeof username === "string" &&
    storedUsername(kv.get(USERNAME_PREFIX + username))?.userId === userId
    ? username
    : undefined;
}
