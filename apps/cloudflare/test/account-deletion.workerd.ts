// Deleting an account against the real Durable Objects.
//
// The claims a Bun double cannot make, because each one is about what the
// deployed objects, bucket, index, database and providers hold afterwards:
//
//  1. Access ends before the request answers, and a deleting account starts
//     nothing new: no Turn, no Bot.
//  2. Driven by nothing but its own alarm, the saga removes every Bot, the
//     voice session, the Computer, the provider accounts, the grants MCP
//     servers issued, the User's files, uploads and Memory vectors, the
//     sign-in identity with its sessions, and the access record and
//     invitation — and nobody else's.
//  3. The User object ends holding its tombstone and nothing else, stays
//     that way across a restart, and refuses to be provisioned again.
//  4. "Delete my Computer" destroys the Computer once per command, and the
//     browser sign-ins kept for it go too: nothing asked for before it can
//     bring them, or a machine, back.
import {
  applyD1Migrations,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, test } from "vitest";
import { workspaceObjectKeyV1 } from "@frockbot/core/workspace-store";
import { ACCOUNT_DELETED_KEY_V1 } from "@frockbot/app/account/deletion";
import {
  uploadObjectKeyV1,
  uploadTextKeyV1,
} from "@frockbot/app/uploads/shared";
import { createUserMemoryEngineV1 } from "../src/memory-records.ts";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "../src/deployment-policy.ts";
import type { FakeComputerHostCall } from "./computer-host-fake.ts";
import {
  COMPOSIO_TEST_API_KEY,
  MCP_AUTH_STUB_ORIGIN,
  MCP_STUB_ORIGIN,
} from "./harness/miniflare.ts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

const HOST = "http://computer-host.internal";
const COMPOSIO = "https://backend.composio.dev/api/v3.1";

interface UserRpc {
  beginAccountDeletion(input: unknown): Promise<{ status: string }>;
  deleteComputer(input: unknown): Promise<{ status: string }>;
  oweComputerLogins(input: unknown): Promise<{ outcome: string }>;
  readComputerLogins(input: unknown): Promise<object>;
  listBots(input: unknown): Promise<{ bots: Array<{ botId: string }> }>;
  createBot(input: unknown): Promise<unknown>;
  prepareAccount(input: unknown): Promise<unknown>;
  reserveUploadQuota(input: unknown): Promise<{ status: string }>;
  executeGroupChatCommand(input: unknown): Promise<unknown>;
  executeConnection(input: unknown): Promise<{
    connectionId: string;
    status: string;
    oauth?: { status: string; authorizationUrl?: string };
  }>;
}

function user(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

function userRpc(userId: string): UserRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the RPCs this suite calls.
  return user(userId) as unknown as UserRpc;
}

function policy() {
  return env.DEPLOYMENT_POLICY.getByName(DEPLOYMENT_POLICY_SINGLETON_NAME);
}

async function composio(
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${COMPOSIO}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": COMPOSIO_TEST_API_KEY,
    },
  });
  return (await response.json()) as Record<string, unknown>;
}

/** A live account at the provider, for one User, the way a sign-in makes one. */
async function connectAccount(userId: string): Promise<string> {
  const created = await composio("/auth_configs", {
    method: "POST",
    body: JSON.stringify({ toolkit: { slug: "weather" } }),
  });
  const account = await composio("/connected_accounts", {
    method: "POST",
    body: JSON.stringify({
      auth_config: {
        id: (created.auth_config as { id: string }).id,
      },
      connection: {
        user_id: userId,
        state: { authScheme: "NO_AUTH", val: { status: "ACTIVE" } },
      },
    }),
  });
  return account.id as string;
}

async function providerAccounts(userId: string): Promise<unknown[]> {
  return (await composio(`/connected_accounts?user_ids=${userId}`))
    .items as unknown[];
}

async function computerCalls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  return ((await response.json()) as { calls: FakeComputerHostCall[] }).calls;
}

async function storedKeys(
  stub: DurableObjectStub,
): Promise<{ keys: string[]; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance, state) => ({
    keys: [...(await state.storage.list()).keys()].sort(),
    alarm: await state.storage.getAlarm(),
  }));
}

/**
 * The message one refused RPC answered with. `expect(...).rejects` would
 * leave the stub's own rejected promise unhandled — a cross-object RPC
 * rejects the call and the disposable it hands back — so it is caught here.
 */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected this call to be refused");
}

/** Runs the User object's alarm until the account is erased, or gives up. */
async function driveDeletion(userId: string): Promise<number> {
  for (let pass = 1; pass <= 40; pass += 1) {
    await runDurableObjectAlarm(user(userId));
    const { keys } = await storedKeys(user(userId));
    if (keys.includes(ACCOUNT_DELETED_KEY_V1)) return pass;
  }
  throw new Error("the account was not erased within 40 alarm passes");
}

beforeAll(async () => {
  await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
  await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
});

describe("deleting an account", () => {
  test("removes everything the User owns, and leaves only a tombstone", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `leaving-${suffix}`;
    const email = `leaving-${suffix}@example.com`;
    const botId = `bot-${suffix}`;
    const siblingId = `sibling-${suffix}`;
    const stranger = `staying-${suffix}`;

    // Two Bots, one of which has talked, and so has a transcript, an audit
    // trail and search rows in the User object.
    await provisionBot({ userId, botId });
    await provisionSiblingBot({ userId, botId: siblingId });
    const turn = await env.BOT_STATES.getByName(`${userId}:${botId}`).run({
      schemaVersion: 1,
      userId,
      botId,
      command: {
        runId: "run-1",
        sessionId: `${userId}:${botId}`,
        acceptedAt: "2026-09-24T00:00:00.000Z",
        text: "hello",
      },
    });
    expect(turn.text).toBe("Ollama reply");
    // And a Group Chat of the two.
    expect(
      await userRpc(userId).executeGroupChatCommand({
        schemaVersion: 1,
        userId,
        command: {
          type: "group/create",
          commandId: `group-${suffix}`,
          members: [botId, siblingId],
        },
      }),
    ).toMatchObject({ ok: true, value: { status: "applied" } });

    // The sign-in identity, a session and a linked Google account.
    const now = new Date().toISOString();
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(
        `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, 1, ?, ?)`,
      ).bind(userId, "Leaving", email, now, now),
      env.AUTH_DB.prepare(
        `insert into "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") values (?, ?, ?, ?, ?, ?)`,
      ).bind(`session-${suffix}`, now, `token-${suffix}`, now, now, userId),
      env.AUTH_DB.prepare(
        `insert into "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") values (?, ?, 'google', ?, ?, ?)`,
      ).bind(`account-${suffix}`, `google-${suffix}`, userId, now, now),
    ]);

    // Access, and an invitation still waiting under the same address.
    expect(
      await policy().setAccountAccess({
        schemaVersion: 1,
        userId,
        command: {
          schemaVersion: 1,
          type: "account/set-access",
          state: "active",
          revision: 0,
        },
        updatedBy: "owner",
      }),
    ).toMatchObject({ status: "applied" });
    await policy().inviteEmail({
      schemaVersion: 1,
      command: { schemaVersion: 1, type: "access/invite-email", email },
      invitedBy: "owner",
    });

    // Files in every kind of root the User owns, and one of someone else's.
    const mine = [
      workspaceObjectKeyV1({ kind: "user-memory", userId }, "notes.md"),
      workspaceObjectKeyV1(
        { kind: "user-instructions", userId },
        "skills/a/SKILL.md",
      ),
      workspaceObjectKeyV1(
        {
          kind: "package-declared",
          userId,
          packageId: "@frockbot/app/notes",
          rootId: "notes",
        },
        "a.md",
      ),
      workspaceObjectKeyV1(
        { kind: "bot-memory", userId, botId: "long-gone" },
        "orphan.md",
      ),
    ];
    const theirs = workspaceObjectKeyV1(
      { kind: "user-memory", userId: stranger },
      "notes.md",
    );
    for (const key of [...mine, theirs]) await env.MEMORY_FILES.put(key, "x");

    // An upload the way the upload route admits one: counted in the User
    // object, its bytes and text in the bucket, and its record in the Bot.
    // Beside it, one left by a Bot already gone, and a stranger's.
    const uploadId = "c".repeat(64);
    expect(
      await userRpc(userId).reserveUploadQuota({
        schemaVersion: 1,
        userId,
        botId,
        uploadId,
        bytes: 1,
      }),
    ).toMatchObject({ status: "reserved" });
    await env.BOT_STATES.getByName(`${userId}:${botId}`).recordUploadV1({
      schemaVersion: 1,
      userId,
      botId,
      upload: {
        schemaVersion: 1,
        uploadId,
        kind: "document",
        name: "notes.md",
        mediaType: "text/markdown",
        bytes: 1,
        uploadedAt: "2026-09-24T00:00:00.000Z",
        textChars: 1,
      },
    });
    const uploads = [
      uploadObjectKeyV1(userId, botId, uploadId),
      uploadTextKeyV1(userId, botId, uploadId),
      uploadObjectKeyV1(userId, "long-gone", uploadId),
    ];
    const strangersUpload = uploadObjectKeyV1(stranger, botId, uploadId);
    for (const key of [...uploads, strangersUpload])
      await env.MEMORY_FILES.put(key, "x");
    expect(
      (await storedKeys(env.BOT_STATES.getByName(`${userId}:${botId}`))).keys,
    ).toContain(`upload:${uploadId}`);
    expect((await storedKeys(user(userId))).keys).toEqual(
      expect.arrayContaining(["uploads:total"]),
    );

    // User Memory vectors the index holds.
    await env.MEMORY_INDEX_PROBE.reset();
    const vectorIds = [
      `user:${userId}:item-1:1:p`,
      `user:${userId}:item-2:1:p`,
    ];
    await runInDurableObject(user(userId), (_instance, state) => {
      createUserMemoryEngineV1(state.storage).open();
      for (const vectorId of vectorIds) {
        state.storage.sql.exec(
          `INSERT INTO memory_vector_ledger (vector_id, scope_key, item_id,
             item_generation, operation, policy_id, mutation_id, state,
             next_attempt_at)
           VALUES (?, ?, ?, 1, 'upsert', 'p', NULL, 'unconfirmed', 0)`,
          vectorId,
          `user:${userId}`,
          vectorId,
        );
      }
    });

    // Provider accounts, the User's and a stranger's.
    await connectAccount(userId);
    await connectAccount(stranger);
    expect(await providerAccounts(userId)).toHaveLength(1);

    // The voice session has woken once, and the Computer holds a file.
    await (await getAgentByName(env.VOICE_ASSISTANTS, userId)).debugSnapshot();
    const voice = env.VOICE_ASSISTANTS.get(
      env.VOICE_ASSISTANTS.idFromName(userId),
    );
    expect((await storedKeys(voice)).keys.length).toBeGreaterThan(0);
    await env.COMPUTER_HOST.fetch(
      new Request(`${HOST}/__fake/file`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, path: "/home/box/a.txt", text: "a" }),
      }),
    );

    // 1. The request records the deletion and ends access before it answers.
    expect(
      await userRpc(userId).beginAccountDeletion({
        schemaVersion: 1,
        userId,
        commandId: `delete-account-${suffix}`,
        email,
      }),
    ).toMatchObject({ status: "deleting" });
    expect(
      (await policy().readAccountAccess({ schemaVersion: 1, userId })).access,
    ).toMatchObject({ state: "ended", updatedBy: "account-deletion" });
    expect(
      await refusal(() =>
        userRpc(userId).prepareAccount({ schemaVersion: 1, userId }),
      ),
    ).toMatch(/deleted/);
    expect(
      await refusal(() =>
        userRpc(userId).createBot({
          schemaVersion: 1,
          userId,
          command: {
            schemaVersion: 1,
            type: "bot/create",
            commandId: `late-${suffix}`,
            expectedRevision: 0,
            botId: `late-${suffix}`,
            name: "Too late",
          },
        }),
      ),
    ).toMatch(/deleted/);
    // A second press joins the deletion under way.
    expect(
      await userRpc(userId).beginAccountDeletion({
        schemaVersion: 1,
        userId,
        commandId: `delete-account-again-${suffix}`,
      }),
    ).toMatchObject({ status: "deleting" });

    // 2. The alarm does the rest.
    await driveDeletion(userId);

    for (const id of [botId, siblingId]) {
      const { keys, alarm } = await storedKeys(
        env.BOT_STATES.getByName(`${userId}:${id}`),
      );
      expect(keys).toEqual([
        expect.stringMatching(/^flock:lifecycle-receipt:account-deletion-/),
        "flock:lifecycle:v1",
      ]);
      expect(alarm).toBeNull();
    }
    expect((await storedKeys(voice)).keys).toEqual([]);
    const teardowns = (await computerCalls()).filter(
      (call) => call.kind === "teardown" && call.userId === userId,
    );
    expect(teardowns).toHaveLength(1);
    const files = (await (
      await env.COMPUTER_HOST.fetch(new Request(`${HOST}/__fake/files`))
    ).json()) as { files: Array<{ userId: string }> };
    expect(files.files.filter((file) => file.userId === userId)).toEqual([]);
    expect(await providerAccounts(userId)).toEqual([]);
    expect(await providerAccounts(stranger)).toHaveLength(1);
    for (const key of mine) expect(await env.MEMORY_FILES.head(key)).toBeNull();
    expect(await env.MEMORY_FILES.head(theirs)).not.toBeNull();
    // The uploads go too — the Bots' own, and the one a lost Bot left — and
    // their records and quota ledger with the objects that held them, which
    // the exact key lists above and below prove.
    for (const key of uploads)
      expect(await env.MEMORY_FILES.head(key)).toBeNull();
    expect(await env.MEMORY_FILES.head(strangersUpload)).not.toBeNull();
    expect((await env.MEMORY_INDEX_PROBE.deletedBatches()).flat()).toEqual(
      expect.arrayContaining(vectorIds),
    );
    for (const table of ["user", "session", "account"]) {
      const column = table === "user" ? "id" : "userId";
      expect(
        await env.AUTH_DB.prepare(
          `select count(*) as n from "${table}" where "${column}" = ?`,
        )
          .bind(userId)
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
    }
    expect(
      (await policy().readAccountAccess({ schemaVersion: 1, userId })).access,
    ).toBeNull();
    expect(
      await policy().mayCreateIdentity({
        schemaVersion: 1,
        email,
        emailVerified: true,
        isAdmin: false,
      }),
    ).toBe(false);

    // 3. The tombstone and nothing else — and still nothing else once the
    // object restarts and its constructor runs its cleanups again.
    expect(await storedKeys(user(userId))).toEqual({
      keys: [ACCOUNT_DELETED_KEY_V1],
      alarm: null,
    });
    await evictDurableObject(user(userId));
    expect(
      await refusal(() =>
        userRpc(userId).listBots({ schemaVersion: 1, userId }),
      ),
    ).toMatch(/deleted/);
    expect(
      await refusal(() =>
        userRpc(userId).beginAccountDeletion({
          schemaVersion: 1,
          userId,
          commandId: `delete-account-late-${suffix}`,
        }),
      ),
    ).toMatch(/deleted/);
    expect((await storedKeys(user(userId))).keys).toEqual([
      ACCOUNT_DELETED_KEY_V1,
    ]);
  });

  test("revokes the grant each MCP server issued before the object is wiped", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `mcp-${suffix}`, botId: `bot-${suffix}` };
    const { userId } = identity;
    await provisionBot(identity);
    const connection = (command: Record<string, unknown>) =>
      userRpc(userId).executeConnection({
        schemaVersion: 1,
        userId,
        command: { schemaVersion: 1, ...command },
      });

    // A server behind OAuth, added and signed in to as the Connectors row
    // does it: the authorization server approves at once and sends back.
    const added = await connection({
      type: "connection/create",
      commandId: `add-${suffix}`,
      packageId: "mcp",
      connectionTypeId: "mcp-server",
      label: "Signed in",
      settings: { url: `${MCP_STUB_ORIGIN}/oauth/mcp` },
    });
    const started = await connection({
      type: "connection/oauth",
      commandId: `sign-in-${suffix}`,
      attemptId: `sign-in-${suffix}`,
      packageId: "mcp",
      action: "start",
      connectionId: added.connectionId,
      callbackUrl: "https://bot.frockbot.com/api/mcp/oauth/callback",
    });
    const approved = await fetch(started.oauth!.authorizationUrl!, {
      redirect: "manual",
    });
    expect(
      await connection({
        type: "connection/oauth",
        commandId: `return-${suffix}`,
        attemptId: `sign-in-${suffix}`,
        packageId: "mcp",
        action: "complete",
        connectionId: added.connectionId,
        code: approved.headers.get("location")!,
      }),
    ).toMatchObject({ status: "applied", oauth: { status: "ready" } });

    const revoked = async () =>
      (await (
        await fetch(`${MCP_AUTH_STUB_ORIGIN}/__revoked`)
      ).json()) as string[];
    const before = await revoked();
    await userRpc(userId).beginAccountDeletion({
      schemaVersion: 1,
      userId,
      commandId: `delete-account-${suffix}`,
    });
    await driveDeletion(userId);

    // The refresh token only the wiped object held was told to the server.
    expect(
      (await revoked())
        .filter((token) => !before.includes(token))
        .filter((token) => token.startsWith("oauth-refresh-")),
    ).toHaveLength(1);
    expect((await storedKeys(user(userId))).keys).toEqual([
      ACCOUNT_DELETED_KEY_V1,
    ]);
  });

  test("a Bot delete repeated after its tombstone settles rather than throwing", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `replay-${suffix}`, botId: `bot-${suffix}` };
    await provisionBot(identity);
    const stub = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    ) as unknown as {
      executeLifecycle(input: unknown): Promise<{
        status: string;
        lifecycle: { status: string };
      }>;
      readLifecycle(input: unknown): Promise<{ status: string }>;
    };
    const command = {
      schemaVersion: 1,
      type: "bot/delete",
      commandId: `delete-${suffix}`,
      botId: identity.botId,
    };
    const envelope = { schemaVersion: 1, ...identity, command };
    expect(await stub.executeLifecycle(envelope)).toMatchObject({
      status: "applied",
      lifecycle: { status: "deleted" },
    });
    // The User's settlement of that answer was lost; its saga asks again,
    // and then reads the lifecycle back. Both find the tombstone.
    expect(await stub.executeLifecycle(envelope)).toMatchObject({
      status: "applied",
      lifecycle: { status: "deleted" },
    });
    expect(
      await stub.readLifecycle({ schemaVersion: 1, ...identity }),
    ).toMatchObject({ status: "deleted" });
  });
});

describe("deleting the Computer", () => {
  test("destroys it once per command, and refuses once the account is going", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `computer-${suffix}`, botId: `bot-${suffix}` };
    await provisionBot(identity);
    const commandId = `delete-computer-${suffix}`;
    const count = async () =>
      (await computerCalls()).filter(
        (call) => call.kind === "teardown" && call.userId === identity.userId,
      ).length;

    const rpc = userRpc(identity.userId);
    expect(
      await rpc.deleteComputer({
        schemaVersion: 1,
        userId: identity.userId,
        commandId,
      }),
    ).toEqual({ schemaVersion: 1, status: "deleted" });
    // A retried press after it worked must not destroy a newer Computer.
    expect(
      await rpc.deleteComputer({
        schemaVersion: 1,
        userId: identity.userId,
        commandId,
      }),
    ).toEqual({ schemaVersion: 1, status: "deleted" });
    expect(await count()).toBe(1);

    await rpc.beginAccountDeletion({
      schemaVersion: 1,
      userId: identity.userId,
      commandId: `delete-account-${suffix}`,
    });
    expect(
      await refusal(() =>
        rpc.deleteComputer({
          schemaVersion: 1,
          userId: identity.userId,
          commandId: `delete-computer-again-${suffix}`,
        }),
      ),
    ).toMatch(/deleted/);
    await driveDeletion(identity.userId);
  });

  test("forgets the kept sign-ins, and refuses an Update asked for before it", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `logins-${suffix}`, botId: `bot-${suffix}` };
    await provisionBot(identity);
    const rpc = userRpc(identity.userId);
    const before = new Date(Date.now() - 60_000).toISOString();
    // An Update is under way: the next machine is owed the sign-ins.
    expect(
      await rpc.oweComputerLogins({
        schemaVersion: 1,
        userId: identity.userId,
        at: before,
      }),
    ).toEqual({ outcome: "owed" });

    await rpc.deleteComputer({
      schemaVersion: 1,
      userId: identity.userId,
      commandId: `delete-computer-${suffix}`,
    });

    const held = (await rpc.readComputerLogins({
      schemaVersion: 1,
      userId: identity.userId,
      capture: true,
    })) as { version: number; deletedAt?: string; owedSince?: string };
    expect(Object.keys(held).sort()).toEqual(["deletedAt", "version"]);
    expect(Date.parse(held.deletedAt!)).toBeGreaterThan(Date.parse(before));
    expect(
      await rpc.oweComputerLogins({
        schemaVersion: 1,
        userId: identity.userId,
        at: before,
      }),
    ).toEqual({ outcome: "deleted" });
  });
});
