// Parity row 29, end to end: a job that outlives the Turn that started it.
//
// The workerd suite proves the protocol pair and the reconciliation rule. What
// only this layer can show is the property the whole feature exists for: a
// process launched in one admitted Turn is still there in the next one, read
// out of the Bot Durable Object's own storage, with its exit code — and that
// checking it reads an outcome rather than launching anything a second time.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computerBotKey } from "@frockbot/plugin-fly-sprite";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "../computer-host-fake.ts";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const HOST = "http://computer-host.internal";
const BOT_ID = "process-bot";
const BOT_KEY = computerBotKey(BOT_ID);
const PROCESS_DIR = `/home/box/.frockbot/bots/${BOT_KEY}/processes`;

interface ClientTurn {
  runId: string;
  events: Array<{
    type: string;
    call?: { id: string; name: string };
    callId?: string;
    content?: string;
    isError?: boolean;
  }>;
}

async function script(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

async function calls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  const body = (await response.json()) as { calls: FakeComputerHostCall[] };
  return body.calls;
}

async function turn(
  userId: string,
  commandId: string,
  text: string,
): Promise<ClientTurn> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${BOT_ID}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as ClientTurn;
}

function toolResult(run: ClientTurn, name: string) {
  const call = run.events.find(
    (event) => event.type === "tool/call" && event.call?.name === name,
  );
  expect(call, `the Turn made no ${name} call`).toBeDefined();
  const result = run.events.find(
    (event) => event.type === "tool/result" && event.callId === call!.call!.id,
  );
  expect(result, `${name} produced no result`).toBeDefined();
  return result!;
}

describe("a background process across two Turns", () => {
  it("launches in one Turn and reports its exit code in the next", async () => {
    const userId = freshUserId("computer-process");
    // The Computer's answers, matched on paths only this Bot's processes use.
    await script({ match: `${PROCESS_DIR}/`, stdout: "" });
    await script({
      match: "setsid nohup",
      stdout: "__FROCKBOT_PROCESS__8100\n",
    });
    await script({
      match: "%salive=%s",
      stdout: "__FROCKBOT_PROCESS__alive=1\n__FROCKBOT_PROCESS__log\nworking\n",
    });
    await provisionThroughGateway({ userId, botId: BOT_ID });

    const first = await turn(
      userId,
      "computer-process-1",
      `${TOOL_CALL_TRIGGER}computer_exec:${JSON.stringify({
        command: "npm run build",
        background: true,
      })}`,
    );
    const launched = toolResult(first, "computer_exec");
    expect(launched.isError, launched.content).toBe(false);
    const answer = JSON.parse(launched.content!) as {
      processId: string;
      pid: number;
      status: string;
    };
    expect(answer).toMatchObject({ pid: 8100, status: "running" });
    // The Bot is told what a background process is worth: it runs while the
    // Computer is awake, and nothing keeps it awake.
    expect(launched.content).toContain("hibernates");

    // The Computer finished the job between the two Turns.
    await script({
      match: "%salive=%s",
      stdout:
        "__FROCKBOT_PROCESS__alive=0\n__FROCKBOT_PROCESS__exit=0\n__FROCKBOT_PROCESS__log\nbuild ok\n",
    });

    const second = await turn(
      userId,
      "computer-process-2",
      `${TOOL_CALL_TRIGGER}computer_process_check:${JSON.stringify({
        processId: answer.processId,
      })}`,
    );
    const checked = toolResult(second, "computer_process_check");
    expect(checked.isError, checked.content).toBe(false);
    const settled = JSON.parse(checked.content!) as {
      status: string;
      exitCode: number;
      command: string;
      pid: number;
    };

    // The record survived the Turn boundary: the second Turn knows the
    // command, the pid and the process id without being told any of them.
    expect(settled).toMatchObject({
      status: "exited",
      exitCode: 0,
      command: "npm run build",
      pid: 8100,
    });

    // And checking read an outcome rather than starting a second process.
    const launches = (await calls()).filter(
      (call) =>
        call.kind === "exec" &&
        call.userId === userId &&
        call.script?.includes("setsid nohup"),
    );
    expect(launches).toHaveLength(1);
  });
});
