// One Turn's audited effects, through the gateway and the loaded artifact.
//
// This is the layer that proves the classifier against a real tool rather than
// against a table of names. The model asks for `computer_exec` against the
// shared Computer host fake; the effect is audited, and the target that comes
// back — `computer` — is the parity item itself (register row 30: shell on the
// box).
//
// It also proves the redaction where it matters. The command carries a bearer
// token; the durable entry carries a digest, a redacted preview, and no
// argument list at all.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEntryV1 } from "@frockbot/app/audit";
import type { FakeExecScript } from "../computer-host-fake.ts";
import { toolCallTriggerPrompt } from "../harness/miniflare.ts";
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

/** `computer/fly` reads the inner command's exit code off this marker. */
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

describe("auditing one Turn's effects", () => {
  it("records the shell call, with its target and no secret", async () => {
    const userId = freshUserId("audit");
    const botId = "auditor";
    const marker = `frockbot-audit-${crypto.randomUUID()}`;
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123";
    await script({
      match: marker,
      stdout: `audited\n${EXEC_EXIT_MARKER}0\n`,
    });
    await provisionThroughGateway({ userId, botId });

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "audit-turn-1",
        text: toolCallTriggerPrompt([
          "computer_exec",
          { command: `echo ${marker} # Authorization: ${secret}` },
        ]),
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
    expect([...byTool.keys()].sort()).toEqual(["computer_exec"]);

    const shell = byTool.get("computer_exec")!;
    expect(shell).toMatchObject({
      botId,
      runId: "audit-turn-1",
      kind: "shell",
      // The Bot's own Computer, not a registered machine.
      target: "computer",
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

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "audit-route-1",
        text: toolCallTriggerPrompt([
          "computer_exec",
          { command: `echo ${marker}` },
        ]),
      }),
    );

    const all = (await expectOkJson(
      await asUser(userId, "/api/audit"),
    )) as AuditPage;
    expect(all.total).toBe(1);
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
