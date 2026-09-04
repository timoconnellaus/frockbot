// One command on the User's own Mac, end to end, through `SELF.fetch`.
//
// This is the parity item (register rows 48 and 49) as a person and a laptop
// actually experience it, and every step is a real request:
//
//   1. a chat Turn calls `machine_exec`, which asks and ends the Turn;
//   2. `GET /turns` renders the approval card, and the machine's queue is
//      empty — nothing has run;
//   3. `POST …/approvals/:id {approved}` records the decision, and only then
//      is the command queued;
//   4. the stub device agent polls, claims and answers with exit 0, over the
//      pre-authentication machine routes, with a bearer token and no session;
//   5. the Bot's next chat Turn is run on a request that carries the result as
//      a preamble line, and `machine_command_check` reads the whole thing;
//   6. `GET /api/audit?target=machine:<id>` has the one shell row, with the
//      command itself absent and a digest in its place.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { machineRoutePathV1 } from "@frockbot/machine-protocol";
import { MachineAgentDriverV1 } from "@frockbot/plugin-user-machine/testing";
import type { AuditEntryV1 } from "@frockbot/plugin-audit";
import { toolCallTriggerPrompt } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const COMMAND = "git status --short";

interface TurnView {
  runId: string;
  status: string;
  events: Array<{
    type: string;
    text?: string;
    content?: string;
    isError?: boolean;
    payload?: { type?: string; approvalId?: string; action?: string };
    request?: { messages?: Array<{ content?: unknown }> };
  }>;
}

interface AuditPage {
  entries: AuditEntryV1[];
  total: number;
}

async function storedRun(
  userId: string,
  botId: string,
  runId: string,
): Promise<TurnView> {
  const run = await readStoredRunWithEventsV1<TurnView>(userId, botId, runId);
  if (!run) throw new Error(`no stored run "${runId}"`);
  return run;
}

function requestTexts(run: TurnView): string[] {
  return run.events
    .filter((event) => event.type === "model/request")
    .flatMap((event) =>
      (event.request?.messages ?? []).map((message) =>
        typeof message.content === "string" ? message.content : "",
      ),
    );
}

async function turn(
  userId: string,
  botId: string,
  commandId: string,
  text: string,
): Promise<TurnView> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as TurnView;
}

describe("running a command on a registered machine", () => {
  it("asks first, runs only once approved, and audits against the machine", async () => {
    const userId = freshUserId("machine-exec");
    const botId = "machine-exec-bot";
    await provisionThroughGateway({ userId, botId });

    // The User pairs their Mac from the settings surface, and the agent on it
    // enrols with the one-time code.
    const offer = (await expectOkJson(
      await postAsUser(userId, machineRoutePathV1("pair"), {
        label: "Tims-M5-MacBook-Pro.local",
      }),
    )) as { code: string; machineId: string };
    const device = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: (input, init) => SELF.fetch(input, init),
      label: "Tims-M5-MacBook-Pro.local",
      platform: "macos",
      agentVersion: "0.4.1",
      capabilities: ["exec", "files"],
      handle: async () => ({
        kind: "result",
        result: {
          finishedAt: new Date().toISOString(),
          outcome: "ok",
          truncated: false,
          exitCode: 0,
          stdout: " M packages/plugin-user-machine/src/agent.ts\n",
        },
      }),
    });
    await device.enroll(offer.code);

    // 1. The Bot asks to run something. The Turn ends there.
    const asked = await turn(
      userId,
      botId,
      "machine-exec-ask",
      toolCallTriggerPrompt([
        "machine_exec",
        { machineId: offer.machineId, command: COMMAND },
      ]),
    );
    // The card is rendered in the transcript, and the Turn that sent it is
    // over: the Bot has nothing left to do until a person answers.
    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: TurnView[] };
    expect(
      transcript.runs.find((run) => run.runId === asked.runId)?.status,
    ).toBe("completed");
    const card = asked.events.find(
      (event) =>
        event.type === "send/to-user" && event.payload?.type === "approval",
    );
    expect(card?.payload?.action).toContain(COMMAND);
    const approvalId = card!.payload!.approvalId!;

    // 2. Nothing has run. The machine's own poll is the only way a command
    //    reaches it, and it answers empty.
    expect(await device.poll()).toEqual([]);

    // 3. The person approves, and only then is the command queued.
    const recorded = await postAsUser(
      userId,
      `/api/bots/${botId}/approvals/${approvalId}`,
      { schemaVersion: 1, decision: "approved" },
    );
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toMatchObject({
      status: "recorded",
      approval: { approvalId, decision: "approved" },
    });

    // 4. The agent polls, claims and answers — the whole protocol, anonymous,
    //    with a bearer token and no session.
    const ran = await device.runOnce();
    expect(ran.delivered.map((command) => command.commandId)).toEqual([
      approvalId,
    ]);
    expect(ran.claimed).toEqual([approvalId]);
    expect(ran.reported).toEqual([approvalId]);

    // 5. The Bot's next chat Turn is run on a request that carries the result
    //    as a preamble line — a preview, ahead of the person's own words.
    const next = await turn(
      userId,
      botId,
      "machine-exec-next",
      toolCallTriggerPrompt([
        "machine_command_check",
        { commandId: approvalId },
      ]),
    );
    const texts = requestTexts(await storedRun(userId, botId, next.runId));
    expect(
      texts.some(
        (text) =>
          text.includes(`Command "${approvalId}"`) &&
          text.includes(`machine ${offer.machineId}`) &&
          text.includes("finished ok"),
      ),
    ).toBe(true);

    // …and `machine_command_check` reads the whole thing on demand, which is
    // why the preamble never has to carry it.
    const read = next.events.find((event) => event.type === "tool/result");
    expect(read?.isError).toBe(false);
    expect(read?.content).toContain("outcome: ok");
    expect(read?.content).toContain("exitCode: 0");
    expect(read?.content).toContain(
      "packages/plugin-user-machine/src/agent.ts",
    );

    // 6. The audit says which machine it ran on. The row carries a digest and
    //    a redacted preview; the argument list itself is never stored, which
    //    is the landed rule for `computer_exec` and is unchanged here.
    const audited = (await expectOkJson(
      await asUser(userId, `/api/audit?target=machine:${offer.machineId}`),
    )) as AuditPage;
    expect(audited.total).toBe(1);
    const row = audited.entries[0]!;
    expect(row).toMatchObject({
      kind: "shell",
      toolName: "machine_exec",
      target: `machine:${offer.machineId}`,
    });
    expect(row.argumentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.hasOwn(row, "arguments")).toBe(false);
    expect(row.outcome).toBe("ok");
  });

  it("runs nothing when the person says no", async () => {
    const userId = freshUserId("machine-deny");
    const botId = "machine-deny-bot";
    await provisionThroughGateway({ userId, botId });

    const offer = (await expectOkJson(
      await postAsUser(userId, machineRoutePathV1("pair"), {}),
    )) as { code: string; machineId: string };
    const device = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: (input, init) => SELF.fetch(input, init),
      label: "Denied.local",
      platform: "macos",
      agentVersion: "0.4.1",
      capabilities: ["exec", "files"],
    });
    await device.enroll(offer.code);

    const asked = await turn(
      userId,
      botId,
      "machine-deny-ask",
      toolCallTriggerPrompt([
        "machine_exec",
        { machineId: offer.machineId, command: "rm -rf /" },
      ]),
    );
    const approvalId = asked.events.find(
      (event) =>
        event.type === "send/to-user" && event.payload?.type === "approval",
    )!.payload!.approvalId!;

    expect(
      (
        await postAsUser(userId, `/api/bots/${botId}/approvals/${approvalId}`, {
          schemaVersion: 1,
          decision: "denied",
        })
      ).status,
    ).toBe(200);

    // A denial reaches the laptop as silence: there was never a command.
    expect(await device.poll()).toEqual([]);
    const checked = await turn(
      userId,
      botId,
      "machine-deny-check",
      toolCallTriggerPrompt([
        "machine_command_check",
        { commandId: approvalId },
      ]),
    );
    const read = checked.events.find((event) => event.type === "tool/result");
    expect(read?.content).toContain("was denied by the user");
  });
});
