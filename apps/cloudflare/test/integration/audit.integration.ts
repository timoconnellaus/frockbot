// One Turn, two audited effects, through the gateway and the loaded artifact.
//
// This is the layer that proves the classifier against real tools rather than
// against a table of names. The model asks for `computer_exec` against the
// shared Computer host fake and for an MCP tool against the stubbed remote
// server, in one Turn; both are audited, and the two targets that come back —
// `computer` and `remote:<host>` — are the parity item itself (register rows
// 30 and 30b: shell on the box, MCP on a remote server, one surface covering
// both).
//
// It also proves the redaction where it matters. The command carries a bearer
// token; the durable entry carries a digest, a redacted preview, and no
// argument list at all.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEntryV1 } from "@frockbot/plugin-audit";
import type { FakeExecScript } from "../computer-host-fake.ts";
import {
  MCP_ENDPOINT,
  MCP_GOOD_API_KEY,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** `plugin-fly-sprite` reads the inner command's exit code off this marker. */
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";

interface AuditPage {
  entries: AuditEntryV1[];
  total: number;
  indexState: string;
}

interface AuditRpc {
  readAuditEntries(input: unknown): Promise<AuditPage>;
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  ) as unknown as AuditRpc;
}

/** Teaches the shared fake Computer host how to answer one exec. */
async function script(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request("http://computer-host.internal/__fake/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

/** Install `mcp`, add the `Example` server, and assign its tools to the Bot. */
async function connectMcpServer(userId: string, botId: string): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as {
    revision: number;
  };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-mcp-${botId}`,
      expectedRevision: settings.revision,
      packageId: "mcp",
      version: "0.0.1",
    }),
  );
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: `connect-mcp-${botId}`,
      packageId: "mcp",
      connectionTypeId: "mcp-remote-key",
      label: "Example",
      apiKey: MCP_GOOD_API_KEY,
      settings: { url: MCP_ENDPOINT, transport: "streamable-http" },
    }),
  )) as { connectionId: string };
  const bot = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/assign-capability",
      commandId: `assign-mcp-${botId}`,
      botId,
      expectedRevision: bot.revision,
      assignment: {
        assignmentId: "mcp-tools-1",
        packageId: "mcp",
        capabilityId: "mcp-tools",
        connectionId: receipt.connectionId,
      },
    }),
  );
}

describe("auditing one Turn's effects", () => {
  it("records the shell call and the MCP call, with two targets and no secret", async () => {
    const userId = freshUserId("audit");
    const botId = "auditor";
    const marker = `frockbot-audit-${crypto.randomUUID()}`;
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123";
    await script({
      match: marker,
      stdout: `audited\n${EXEC_EXIT_MARKER}0\n`,
    });
    await provisionThroughGateway({ userId, botId });
    await connectMcpServer(userId, botId);

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "audit-turn-1",
        text: toolCallTriggerPrompt(
          [
            "computer_exec",
            { command: `echo ${marker} # Authorization: ${secret}` },
          ],
          ["mcp__example__echo", { message: "audited" }],
        ),
      }),
    )) as { runId: string };
    expect(turn.runId).toBe("audit-turn-1");

    const page = await userStub(userId).readAuditEntries({
      schemaVersion: 1,
      userId,
    });
    const byTool = new Map(
      page.entries.map((entry) => [entry.toolName, entry]),
    );
    expect([...byTool.keys()].sort()).toEqual([
      "computer_exec",
      "mcp__example__echo",
    ]);

    const shell = byTool.get("computer_exec")!;
    expect(shell).toMatchObject({
      botId,
      runId: "audit-turn-1",
      kind: "shell",
      // The Bot's own Computer, not a registered machine.
      target: "computer",
    });
    // THE HOST IS RESOLVED FROM THE CONNECTION REGISTRY. The tool name carries
    // the Connection's slug; the User Durable Object owns the settings that
    // say which server that is, and it is the only place the two are joined.
    expect(byTool.get("mcp__example__echo")).toMatchObject({
      kind: "mcp",
      target: "remote:mcp.example.test",
    });

    // A DIGEST, NOT THE ARGUMENTS. The command line never reaches the table.
    for (const entry of page.entries) {
      expect(entry.argumentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.occurrenceId).toMatch(/^tool:\d+:\d+:\d+$/);
      expect(entry.effectId).toBe(entry.occurrenceId);
    }
    const wire = JSON.stringify(page.entries);
    expect(wire).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(wire).not.toContain("credentialRef");
    expect(shell.preview).toContain("[redacted:bearer-token]");
    // The preview keeps enough of the command to be worth reading, and none of
    // the secret.
    expect(shell.preview).toContain(marker);
  });

  it("filters by kind through the route, and rebuilds to the same count", async () => {
    const userId = freshUserId("audit-route");
    const botId = "route-auditor";
    const marker = `frockbot-route-${crypto.randomUUID()}`;
    await script({
      match: marker,
      stdout: `audited\n${EXEC_EXIT_MARKER}0\n`,
    });
    await provisionThroughGateway({ userId, botId });
    await connectMcpServer(userId, botId);

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "audit-route-1",
        text: toolCallTriggerPrompt(
          ["computer_exec", { command: `echo ${marker}` }],
          ["mcp__example__echo", { message: "routed" }],
        ),
      }),
    );

    const all = (await expectOkJson(
      await asUser(userId, "/api/audit"),
    )) as AuditPage;
    expect(all.total).toBe(2);
    expect(all.indexState).toBe("ready");

    // THE FILTER IS APPLIED IN THE TABLE, not by the client. `?kind=shell`
    // returns the shell entry and nothing else, and the total it reports is
    // the filtered total.
    const shellOnly = (await expectOkJson(
      await asUser(userId, "/api/audit?kind=shell"),
    )) as AuditPage;
    expect(shellOnly.entries.map((entry) => entry.toolName)).toEqual([
      "computer_exec",
    ]);
    expect(shellOnly.total).toBe(1);

    const remote = (await expectOkJson(
      await asUser(userId, "/api/audit?target=remote:mcp.example.test"),
    )) as AuditPage;
    expect(remote.entries.map((entry) => entry.kind)).toEqual(["mcp"]);

    // A REBUILD ACCOUNTS FOR EXACTLY WHAT WAS THERE. The receipt is the claim,
    // and the table after it is the evidence.
    const receipt = (await expectOkJson(
      await postAsUser(userId, "/api/audit/rebuild", {}),
    )) as {
      status: string;
      entries: number;
      indexState: string;
      unknownOutcomes: number;
      hostJournalDiscrepancies: number;
    };
    expect(receipt).toMatchObject({
      status: "rebuilt",
      indexState: "ready",
      unknownOutcomes: 0,
      hostJournalDiscrepancies: 0,
    });
    expect(receipt.entries).toBe(all.total);
    const after = (await expectOkJson(
      await asUser(userId, "/api/audit"),
    )) as AuditPage;
    expect(after.entries).toEqual(all.entries);
  });

  it("refuses a query parameter the route does not implement", async () => {
    const userId = freshUserId("audit-refuse");
    await provisionThroughGateway({ userId, botId: "refuser" });
    const refused = await asUser(userId, "/api/audit?userId=someone");
    expect(refused.status).toBe(400);
    expect(await expectJson(refused)).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });
    const repeated = await asUser(userId, "/api/audit?kind=shell&kind=mcp");
    expect(repeated.status).toBe(400);
  });
});
