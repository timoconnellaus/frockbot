import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  ORIGIN,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const DEBUG_TOKEN = "integration-debug-token";

interface RunView {
  runId: string;
  input: string;
}

async function seedIdentity(userId: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  await env.AUTH_DB.prepare(
    'insert into "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(userId, "Debug operator", email, 1, null, now, now)
    .run();
}

function sendDebugTurn(
  userId: string,
  botId: string,
  text: string,
  token?: string,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(
    `${ORIGIN}/api/debug/users/${encodeURIComponent(userId)}/bots/${encodeURIComponent(botId)}/turns`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    },
  );
}

describe("the owner-only debug Turn send", () => {
  it("requires both the token and an allowlisted stored identity, then uses the ordinary Turn path", async () => {
    const adminUserId = freshUserId("debug-owner");
    const adminBotId = "debug-owner-bot";
    const ordinaryUserId = freshUserId("debug-member");
    const ordinaryBotId = "debug-member-bot";
    await seedIdentity(adminUserId, "owner@example.com");
    await seedIdentity(
      ordinaryUserId,
      `member-${crypto.randomUUID()}@example.com`,
    );
    await provisionThroughGateway({ userId: adminUserId, botId: adminBotId });
    await provisionThroughGateway({
      userId: ordinaryUserId,
      botId: ordinaryBotId,
    });

    const withoutToken = await sendDebugTurn(
      adminUserId,
      adminBotId,
      "no token",
    );
    expect(withoutToken.status).toBe(401);

    const deniedText = "this must never be admitted";
    const nonAdmin = await sendDebugTurn(
      ordinaryUserId,
      ordinaryBotId,
      deniedText,
      DEBUG_TOKEN,
    );
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.headers.get("content-type")).toContain("text/plain");
    expect(await nonAdmin.text()).toContain("administrator account");
    const ordinaryTranscript = (await expectOkJson(
      await asUser(ordinaryUserId, `/api/bots/${ordinaryBotId}/turns`),
    )) as { runs: RunView[] };
    expect(
      ordinaryTranscript.runs.some((run) => run.input === deniedText),
    ).toBe(false);

    const message = "hello from the production debug surface";
    const admitted = await sendDebugTurn(
      adminUserId,
      adminBotId,
      message,
      DEBUG_TOKEN,
    );
    expect([200, 202]).toContain(admitted.status);
    const admittedBody = (await expectJson(admitted)) as { runId?: unknown };
    expect(admittedBody.runId).toEqual(expect.any(String));
    const adminTranscript = (await expectOkJson(
      await asUser(adminUserId, `/api/bots/${adminBotId}/turns`),
    )) as { runs: RunView[] };
    expect(adminTranscript.runs).toContainEqual(
      expect.objectContaining({ runId: admittedBody.runId, input: message }),
    );

    const wrongBot = await sendDebugTurn(
      adminUserId,
      "not-the-owner-bot",
      "wrong Bot",
      DEBUG_TOKEN,
    );
    expect(wrongBot.status).toBe(404);
  });
});
