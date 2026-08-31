// Parity rows 27 and 33, end to end.
//
// `computer-doctor.workerd.ts` proves the one host operation on the real wire.
// What only this layer can show is the rest of the path: the Agent loop
// admitting the call, the Computer Package filing the report *through* the
// Workspace so the Bot is recorded as its writer, the card-shaped JSON the
// model reads back — and, on the same Computer, a `chromium …` command
// refused before it ever reaches a shell.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computerBotKey } from "@frockbot/plugin-fly-sprite";
import type { FakeExecScript } from "../computer-host-fake.ts";
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
const BOT_ID = "doctor-bot";
const BOT_KEY = computerBotKey(BOT_ID);
const DOCTOR_SCRIPT = "/home/box/.frockbot/box-doctor.sh";
const DOCTOR_MARKER = "__FROCKBOT_DOCTOR__";
const DOCTOR_ROOT = "/home/box/agent-data/user-packages/computer/doctor";

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

function reportLine(): string {
  return `${DOCTOR_MARKER}${JSON.stringify({
    schemaVersion: 2,
    generation: 1,
    capturedAt: "2026-09-01T00:00:00Z",
    checks: [
      { name: "disk-root", status: "pass", detail: "11% full, 90 GiB free" },
      { name: "scratch", status: "pass", detail: "/workspace holds 0 MiB" },
      { name: "dns", status: "fail", detail: "api.fly.io does not resolve" },
    ],
    browserIdentity: {
      userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      webdriver: false,
      brands: ["Chromium/141"],
    },
    summary: "3 checks, 2 passed, 1 failed",
  })}\n`;
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
}

async function script(rule: FakeExecScript): Promise<void> {
  await post("/__fake/exec", rule);
}

function resultOf(turn: ClientTurn, name: string) {
  const call = turn.events.find(
    (event) => event.type === "tool/call" && event.call?.name === name,
  );
  expect(call, `the Turn made no ${name} call`).toBeDefined();
  return turn.events.find(
    (event) => event.type === "tool/result" && event.callId === call!.call!.id,
  );
}

describe("a Turn whose model asks the Computer how it is", () => {
  it("answers a card-shaped report and files it under the doctor root", async () => {
    const userId = freshUserId("computer-doctor");
    await script({ match: DOCTOR_ROOT, stdout: "" });
    await script({ match: "echo __WRITTEN__", stdout: "__WRITTEN__\n" });
    await script({ match: DOCTOR_SCRIPT, stdout: reportLine() });
    await provisionThroughGateway({ userId, botId: BOT_ID });

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${BOT_ID}/turns`, {
        schemaVersion: 1,
        commandId: "computer-doctor-1",
        text: `${TOOL_CALL_TRIGGER}computer_doctor:{}`,
      }),
    )) as ClientTurn;

    const result = resultOf(turn, "computer_doctor");
    // A failing check is a report, not a tool error: an unhealthy Computer
    // that answered is a different thing from one that did not.
    expect(result?.isError, result?.content).toBe(false);

    const report = JSON.parse(result!.content!) as {
      schemaVersion: number;
      generation: number;
      summary: string;
      capturedAt: string;
      rootId?: string;
      path?: string;
      checks: { name: string; status: string; detail: string }[];
      browserIdentity?: {
        userAgent: string;
        webdriver: boolean;
        brands: string[];
      };
    };
    expect(report.schemaVersion).toBe(2);
    expect(report.summary).toBe("3 checks, 2 passed, 1 failed");
    expect(report.checks.map((check) => check.name)).toEqual([
      "disk-root",
      "scratch",
      "dns",
    ]);
    expect(
      report.checks.filter((check) => check.status === "fail"),
    ).toHaveLength(1);
    // Parity row 34b: the browser measurement reaches the model with the rest
    // of the report, so what our browser announces itself as is readable
    // without a second call.
    expect(report.browserIdentity).toEqual({
      userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      webdriver: false,
      brands: ["Chromium/141"],
    });
    // Filed through the Workspace, which is what records the Bot as its
    // writer; a report left on the Computer would sync back `unattributed`.
    expect(report.rootId).toBe("doctor");
    expect(report.path).toBe(`${BOT_KEY}/latest.json`);
  });

  it("refuses a shell command that reaches for the GUI, before the Computer sees it", async () => {
    const userId = freshUserId("computer-gui");
    await script({ match: DOCTOR_SCRIPT, stdout: reportLine() });
    await provisionThroughGateway({ userId, botId: BOT_ID });

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${BOT_ID}/turns`, {
        schemaVersion: 1,
        commandId: "computer-gui-1",
        text: `${TOOL_CALL_TRIGGER}computer_exec:{"command":"chromium --headless https://example.com"}`,
      }),
    )) as ClientTurn;

    const result = resultOf(turn, "computer_exec");
    expect(result?.isError).toBe(true);
    // The refusal names what to use instead — the whole reason the policy
    // lives at the seam where the model can read it, rather than only in a
    // shim on the Computer.
    expect(result?.content).toContain("never driven from the shell");
    expect(result?.content).toContain("computer_browser");
    expect(result?.content).toContain("computer_screenshot");
    expect(result?.content).toContain("frockbot-chrome");
  });
});
