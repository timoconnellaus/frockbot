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

function startApp(
  userId: string,
  commandId: string,
  app: string,
  returnClient?: string,
) {
  return postAsUser(userId, "/api/plugins/connect/connections", {
    schemaVersion: 1,
    type: "connection/start",
    commandId,
    connectionTypeId: `connect-${app}`,
    ...(returnClient === undefined ? {} : { returnClient }),
  });
}

/** The return page the gateway named on the sign-in it handed the person. */
function callbackOf(redirectUrl: string): string | null {
  return new URL(redirectUrl).searchParams.get("callback");
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

  it("sends each app back through its own return page, and serves it", async () => {
    const userId = freshUserId("connect-return");
    await provisionThroughGateway({ userId, botId: "return" });

    // What each client asks for is the page it can come back through, on
    // this deployment's own origin — never one the caller supplies.
    const phone = (await expectOkJson(
      await startApp(userId, "start-android", "github", "android"),
    )) as { redirectUrl: string };
    expect(callbackOf(phone.redirectUrl)).toBe(
      `${ORIGIN}/api/connect/callback/android`,
    );
    const mac = (await expectOkJson(
      await startApp(userId, "start-macos", "slack", "macos"),
    )) as { redirectUrl: string };
    expect(callbackOf(mac.redirectUrl)).toBe(
      `${ORIGIN}/api/connect/callback/macos`,
    );
    const tab = (await expectOkJson(
      await startApp(userId, "start-tab", "gmail"),
    )) as { redirectUrl: string };
    expect(callbackOf(tab.redirectUrl)).toBe(`${ORIGIN}/api/connect/callback`);

    // The phone's page: the verified link has already opened the app, so the
    // page carries no script and nothing from the query.
    const android = await SELF.fetch(
      `${ORIGIN}/api/connect/callback/android?status=success&connectedAccountId=ca_9`,
    );
    expect(android.status).toBe(200);
    const androidPage = await android.text();
    expect(androidPage).toContain("Head back to the FrockBot app");
    expect(androidPage).not.toContain("safe to close");
    expect(androidPage).not.toContain("<script");
    expect(androidPage).not.toContain("ca_9");
    expect(android.headers.get("content-security-policy")).not.toContain(
      "script-src",
    );

    // The Mac's page hands over on the app's scheme, under its own nonce.
    const macos = await SELF.fetch(
      `${ORIGIN}/api/connect/callback/macos?status=success&connectedAccountId=ca_9`,
    );
    const macPage = await macos.text();
    expect(macPage).toContain(
      "frockbot://bot.frockbot.com/api/connect/callback/macos",
    );
    expect(macPage).toContain("Open FrockBot");
    expect(macPage).not.toContain("ca_9");
    expect(macos.headers.get("content-security-policy")).toMatch(
      /script-src 'nonce-[0-9a-f-]{36}'/,
    );
    expect(macos.headers.get("content-security-policy")).not.toContain(
      "unsafe-inline",
    );

    // A browser tab is given the way back by hand.
    const plain = await SELF.fetch(`${ORIGIN}/api/connect/callback`);
    const plainPage = await plain.text();
    expect(plainPage).toContain(`href="${ORIGIN}/"`);
    expect(plainPage).not.toContain("<script");

    // Nothing else under the callback path is a page of ours, and the pages
    // that exist are read, never posted to.
    const notOurs = await SELF.fetch(`${ORIGIN}/api/connect/callback/ios`);
    // Not a public page: it never reaches the return page at all, it hits
    // the gateway's door like any other unknown path.
    expect(notOurs.status).toBe(401);
    expect(await notOurs.text()).not.toContain("Back to FrockBot");
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/connect/callback/android`, {
          method: "POST",
        })
      ).status,
    ).toBe(405);
    // A client naming a return page that is not ours is refused outright.
    expect(
      (await startApp(userId, "start-ios", "gmail", "ios")).status,
    ).toBeGreaterThanOrEqual(400);
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

  it("holds two accounts of one app, each under its own namespace", async () => {
    const userId = freshUserId("connect-two-gmails");
    const botId = "two-gmails";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(await startApp(userId, "gmail-one", "gmail"));
    expect((await connections(userId))[0]?.state).toBe("ready");
    await expectOkJson(await startApp(userId, "gmail-two", "gmail"));

    const rows = await connections(userId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.state === "ready")).toBe(true);
    expect(rows.map((row) => row.safeMetadata.namespace).sort()).toEqual([
      "gmail",
      "gmail-2",
    ]);
    expect(rows.map((row) => row.displayName).sort()).toEqual([
      "Gmail",
      "Gmail 2",
    ]);
    // Two accounts, two upstream grants: the second is not the first again.
    expect(rows[0]?.safeMetadata.connectedAccountId).not.toBe(
      rows[1]?.safeMetadata.connectedAccountId,
    );

    // A Bot reaches the second account by its own namespace.
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "send-from-second",
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          {
            namespace: "gmail-2",
            toolName: "send_email",
            arguments: { to: "second@example.com", body: "hi" },
          },
        ]),
      }),
    )) as {
      events: Array<{ type: string; content?: string; isError?: boolean }>;
    };
    const result = turn.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result!.content!)).toMatchObject({
      to: "second@example.com",
    });
  });

  it("retires the sign-in that failed when the person connects again", async () => {
    const userId = freshUserId("connect-retry");
    await provisionThroughGateway({ userId, botId: "retry" });
    const first = (await expectOkJson(
      await startApp(userId, "slack-one", "slack"),
    )) as { connectionId: string };
    expect((await connections(userId))[0]?.state).toBe("failed");

    const second = (await expectOkJson(
      await startApp(userId, "slack-two", "slack"),
    )) as { connectionId: string };
    expect(second.connectionId).not.toBe(first.connectionId);

    const rows = await connections(userId);
    // The dead row is retired, and the retry — not a second account — keeps
    // the app's own name and namespace.
    expect(
      rows.find((row) => row.connectionId === first.connectionId)?.state ??
        "revoked",
    ).toBe("revoked");
    const retry = rows.find((row) => row.connectionId === second.connectionId);
    expect(retry?.displayName).toBe("Slack");
    expect(retry?.safeMetadata.namespace).toBe("slack");
  });

  it("keeps the settings read moving when one app's provider hangs", async () => {
    const userId = freshUserId("connect-hang");
    await provisionThroughGateway({ userId, botId: "hang" });
    // Notion's account read never answers in the harness; Gmail's does.
    await expectOkJson(await startApp(userId, "hang-notion", "notion"));
    await expectOkJson(await startApp(userId, "hang-gmail", "gmail"));

    const started = Date.now();
    const rows = await connections(userId);
    const elapsed = Date.now() - started;
    // Without the read deadline this waits on the 20s hang; with it, ~5s.
    expect(elapsed).toBeLessThan(15_000);

    const gmail = rows.find((row) => row.connectionTypeId === "connect-gmail");
    const notion = rows.find(
      (row) => row.connectionTypeId === "connect-notion",
    );
    expect(gmail?.state).toBe("ready");
    // The unreachable one is left where it was, to be asked about again.
    expect(notion?.state).toBe("authorizing");
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
