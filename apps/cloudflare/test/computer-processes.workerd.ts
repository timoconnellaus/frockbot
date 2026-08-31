// A background process over the real v1 protocol: launch, check, a Computer
// that moved under it, and stop.
//
// The unit suites prove the scripts and the status rule separately. What only
// exists here is the whole reconciliation happening across a real service
// binding with a real Durable Object holding the record: the probe writes its
// intent to Durable Object storage before it launches, and answers `unknown`
// rather than `running` once the host reports a different provisioning
// generation.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import type { FakeExecScript } from "./computer-host-fake.ts";

const HOST = "http://computer-host.internal";
const BOT_ID = "process-bot";

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

function probe() {
  return env.FLY_COMPATIBILITY.getByName("processes");
}

beforeAll(async () => {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
  expect(response.status).toBe(200);
  await post("/__fake/generation", { generation: 1 });
  // The Computer's answers, keyed by the paths only this Bot's process uses.
  await script({ match: `setsid nohup`, stdout: "__FROCKBOT_PROCESS__7001\n" });
});

describe("a background process through the shared Computer host", () => {
  test("launches, reports running, and ends with an exit code", async () => {
    const launched = await probe().backgroundProcess({
      botId: BOT_ID,
      command: "sleep 600",
      action: "launch",
      processId: "p-probe",
    });
    expect(launched, launched.message).toMatchObject({
      ok: true,
      processId: "p-probe",
      pid: 7001,
    });

    await script({
      match: "%salive=%s",
      stdout: "__FROCKBOT_PROCESS__alive=1\n__FROCKBOT_PROCESS__log\nworking\n",
    });
    const running = await probe().backgroundProcess({
      botId: BOT_ID,
      command: "",
      action: "check",
      processId: "p-probe",
    });
    expect(running).toMatchObject({ ok: true, status: "running" });
    expect(running.logTail).toContain("working");

    await script({
      match: "%salive=%s",
      stdout:
        "__FROCKBOT_PROCESS__alive=0\n__FROCKBOT_PROCESS__exit=0\n__FROCKBOT_PROCESS__log\ndone\n",
    });
    const stopped = await probe().backgroundProcess({
      botId: BOT_ID,
      command: "",
      action: "stop",
      processId: "p-probe",
    });
    expect(stopped).toMatchObject({ ok: true, status: "exited", exitCode: 0 });
  });

  test("answers unknown, not running, once the Computer's generation moved", async () => {
    await post("/__fake/generation", { generation: 1 });
    const launched = await probe().backgroundProcess({
      botId: BOT_ID,
      command: "sleep 600",
      action: "launch",
      processId: "p-rebuilt",
    });
    expect(launched.ok, launched.message).toBe(true);

    // The Computer was reprovisioned. Its pid table says something is alive;
    // that something is not this process.
    await post("/__fake/generation", { generation: 2 });
    await script({
      match: "%salive=%s",
      stdout: "__FROCKBOT_PROCESS__alive=1\n__FROCKBOT_PROCESS__log\n",
    });

    const checked = await probe().backgroundProcess({
      botId: BOT_ID,
      command: "",
      action: "check",
      processId: "p-rebuilt",
    });

    expect(checked).toMatchObject({ ok: true, status: "unknown" });
  });
});
