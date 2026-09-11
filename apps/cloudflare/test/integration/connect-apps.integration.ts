// Connected apps, end to end through the gateway: the Connectors row, the
// hosted sign-in hand-off, the settle on the next read, the public return
// page, a Bot calling the app's tool through its namespace, and the
// disconnect that revokes upstream. The provider is the harness stub at
// `backend.composio.dev`, keyed like production.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface ConnectionRow {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  state: string;
  failure?: string;
  safeMetadata: Record<string, unknown>;
}

async function connections(userId: string): Promise<ConnectionRow[]> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { connections: ConnectionRow[] };
  return settings.connections.filter((row) => row.packageId === "connect");
}

function startApp(userId: string, commandId: string, app: string) {
  return postAsUser(userId, "/api/plugins/connect/connections", {
    schemaVersion: 1,
    type: "connection/start",
    commandId,
    connectionTypeId: `connect-${app}`,
  });
}

describe("Connected apps", () => {
  it("offers each app as its own Connectors row", async () => {
    const userId = freshUserId("connect-rows");
    await provisionThroughGateway({ userId, botId: "rows" });
    const frame = (await expectOkJson(
      await asUser(userId, "/api/settings/connections"),
    )) as {
      providers: Array<{
        displayName: string;
        kind: string;
        authorization: string;
        icon?: string;
        description?: string;
      }>;
    };
    for (const name of ["Gmail", "Google Calendar", "GitHub", "Slack"]) {
      const row = frame.providers.find((p) => p.displayName === name);
      expect(row).toMatchObject({
        kind: "connector",
        authorization: "grant",
      });
      expect(row?.icon).toBeDefined();
      expect(row?.description).toBeDefined();
    }
    // The provider is plumbing: it is named nowhere a person reads.
    expect(JSON.stringify(frame).toLowerCase()).not.toContain("composio");
  });

  it("hands the person to the app's sign-in and settles the account on the next read", async () => {
    const userId = freshUserId("connect-gmail");
    await provisionThroughGateway({ userId, botId: "gmail" });

    const started = (await expectOkJson(
      await startApp(userId, "start-gmail", "gmail"),
    )) as { status: string; connectionId: string; redirectUrl: string };
    expect(started.status).toBe("authorization-required");
    expect(started.redirectUrl).toMatch(/^https:\/\/connect\.example\.test\//);

    // The person lands back on the public page with no session at all.
    const returned = await SELF.fetch(
      `${ORIGIN}/api/connect/callback?status=success`,
    );
    expect(returned.status).toBe(200);
    expect(await returned.text()).toContain("Back to FrockBot");

    const [gmail] = await connections(userId);
    expect(gmail).toMatchObject({
      connectionId: started.connectionId,
      connectionTypeId: "connect-gmail",
      displayName: "Gmail",
      state: "ready",
    });
    expect(gmail?.safeMetadata).toMatchObject({
      toolkitSlug: "gmail",
      namespace: "gmail",
    });
    expect(JSON.stringify(gmail)).not.toContain("workerd-composio-key");

    // The same command again is the same answer, not a second sign-in.
    const replay = (await expectOkJson(
      await startApp(userId, "start-gmail", "gmail"),
    )) as { connectionId: string };
    expect(replay.connectionId).toBe(started.connectionId);
    expect(await connections(userId)).toHaveLength(1);
  });

  it("tells the person when a sign-in did not finish", async () => {
    const userId = freshUserId("connect-slack");
    await provisionThroughGateway({ userId, botId: "slack" });
    await expectOkJson(await startApp(userId, "start-slack", "slack"));
    const [slack] = await connections(userId);
    expect(slack).toMatchObject({
      connectionTypeId: "connect-slack",
      state: "failed",
      failure: "Sign-in didn't finish. Connect it again.",
    });
  });

  it("gives every Bot the app's tools under its namespace, and runs one", async () => {
    const userId = freshUserId("connect-tool");
    const botId = "tool-bot";
    await provisionThroughGateway({ userId, botId });
    await expectOkJson(await startApp(userId, "start-gmail", "gmail"));
    expect((await connections(userId))[0]?.state).toBe("ready");

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "send-one",
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          {
            namespace: "gmail",
            toolName: "send_email",
            arguments: { to: "a@example.com", body: "hello" },
          },
        ]),
      }),
    )) as {
      events: Array<{
        type: string;
        content?: string;
        isError?: boolean;
      }>;
    };
    const result = turn.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result!.content!)).toEqual({
      id: "msg_1",
      tool: "GMAIL_SEND_EMAIL",
      to: "a@example.com",
      body: "hello",
    });
  });

  it("disconnects through the Package route and revokes upstream", async () => {
    const userId = freshUserId("connect-revoke");
    await provisionThroughGateway({ userId, botId: "revoke" });
    const started = (await expectOkJson(
      await startApp(userId, "start-gmail", "gmail"),
    )) as { connectionId: string };
    expect((await connections(userId))[0]?.state).toBe("ready");

    const revoked = await postAsUser(
      userId,
      `/api/plugins/connect/connections/${started.connectionId}/revoke`,
      { schemaVersion: 1, type: "connection/revoke" },
    );
    expect(await expectOkJson(revoked)).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    const after = await connections(userId);
    expect(
      after.find((row) => row.connectionId === started.connectionId)?.state ??
        "revoked",
    ).toBe("revoked");

    // Nothing to mount now: the Bot no longer holds the namespace.
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/revoke/turns`, {
        schemaVersion: 1,
        commandId: "send-after-revoke",
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          {
            namespace: "gmail",
            toolName: "send_email",
            arguments: { to: "x" },
          },
        ]),
      }),
    )) as { events: Array<{ type: string; isError?: boolean }> };
    expect(
      turn.events.find((event) => event.type === "tool/result"),
    ).toMatchObject({ isError: true });
  });
});
