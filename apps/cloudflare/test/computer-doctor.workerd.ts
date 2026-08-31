// `computer_doctor`'s one host operation, on the real wire.
//
// The unit suite in `packages/plugin-fly-sprite/src/doctor.test.ts` proves the
// script the provider builds against a double, and
// `packages/computer-host-runtime/src/runtime.test.ts` runs the real
// `box-doctor.sh` and reads its log. What only exists here is the exec
// travelling the v1 protocol over a workerd service binding, the report being
// decoded at the provider seam, and both the run and the tenant it names
// landing on one shard for one User.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { computerBotKey } from "@frockbot/plugin-fly-sprite";
import type {
  FakeComputerHostCall,
  FakeExecScript,
} from "./computer-host-fake.ts";

const HOST = "http://computer-host.internal";
// Written out rather than imported: these three are the contract between the
// Computer's script and everything that reads it, and a test that imported
// them would agree with the runtime by construction. GrokBot's log path is
// kept exactly (`grokbot-computer.md:396`).
const DOCTOR_SCRIPT = "/home/box/.frockbot/box-doctor.sh";
const DOCTOR_MARKER = "__FROCKBOT_DOCTOR__";
const DOCTOR_LOG = "/tmp/box-doctor.log";

/** What the installed script prints: its report, on one marked line. */
function reportLine(
  checks: { name: string; status: string; detail: string }[],
  browserIdentity: unknown = null,
) {
  const failed = checks.filter((check) => check.status === "fail").length;
  return `${DOCTOR_MARKER}${JSON.stringify({
    schemaVersion: 2,
    generation: 1,
    capturedAt: "2026-09-01T00:00:00Z",
    checks,
    browserIdentity,
    summary: `${checks.length} checks, ${checks.length - failed} passed, ${failed} failed`,
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

async function calls(): Promise<FakeComputerHostCall[]> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/calls`),
  );
  const body = (await response.json()) as { calls: FakeComputerHostCall[] };
  return body.calls;
}

async function script(rule: FakeExecScript): Promise<void> {
  await post("/__fake/exec", rule);
}

beforeAll(async () => {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
  expect(response.status).toBe(200);
});

describe("the Computer's self-check through the shared Computer host", () => {
  test("runs the installed script for the tenant and decodes its report", async () => {
    const checks = [
      { name: "disk-root", status: "pass", detail: "11% full, 90 GiB free" },
      { name: "scratch", status: "pass", detail: "/workspace holds 0 MiB" },
      { name: "dns", status: "fail", detail: "api.fly.io does not resolve" },
    ];
    await script({ match: DOCTOR_SCRIPT, stdout: reportLine(checks) });

    const report =
      await env.FLY_COMPATIBILITY.getByName("doctor").doctor("doctor-ok");

    expect(report, JSON.stringify(report)).toMatchObject({
      ok: true,
      schemaVersion: 2,
      generation: 1,
      summary: "3 checks, 2 passed, 1 failed",
    });
    // A failing check is a report, not a tool failure: an unhealthy Computer
    // that answered is a different thing from one that did not.
    expect((report as { checks: unknown[] }).checks).toHaveLength(3);

    const recorded = (await calls()).filter(
      (call) => call.botId === "doctor-ok",
    );
    const exec = recorded.find(
      (call) => call.kind === "exec" && call.script?.includes(DOCTOR_SCRIPT),
    );
    expect(exec).toBeDefined();
    // The tenant's own key and the generation the host reported, so a report
    // read later says which Computer it describes.
    expect(exec!.script).toContain(
      `${DOCTOR_SCRIPT} '${computerBotKey("doctor-ok")}' 1`,
    );
    // Read-only, and not behind the human-control guard: a Computer somebody
    // has taken over is exactly a Computer somebody is debugging.
    expect(exec!.script).not.toContain("assert-agent");
    expect(exec!.script).toContain("last-seen");
    // One User, one Computer: the open and the self-check cannot land on two
    // different shards.
    const opened = recorded.find((call) => call.kind === "open");
    expect(exec!.shard).toBe(opened?.shard);
    expect(exec!.userId).toBe("workerd");
  });

  // Parity row 34b: the browser measurement crosses the same seam as the
  // checks, decoded rather than handed back as a string, and a Computer that
  // measured nothing says so with `null` rather than an empty user agent.
  test("carries what the browser announced itself as", async () => {
    await script({
      match: DOCTOR_SCRIPT,
      stdout: reportLine(
        [
          {
            name: "browser-identity",
            status: "pass",
            detail: "the browser presents no automation tell",
          },
        ],
        {
          userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
          webdriver: false,
          brands: ["Chromium/141", "Not?A_Brand/24"],
        },
      ),
    });

    const report =
      await env.FLY_COMPATIBILITY.getByName("doctor-identity").doctor(
        "doctor-identity",
      );

    expect(report, JSON.stringify(report)).toMatchObject({
      ok: true,
      browserIdentity: {
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
        webdriver: false,
        brands: ["Chromium/141", "Not?A_Brand/24"],
      },
    });

    await script({
      match: DOCTOR_SCRIPT,
      stdout: reportLine([
        { name: "browser-identity", status: "fail", detail: "no browser" },
      ]),
    });
    const unmeasured =
      await env.FLY_COMPATIBILITY.getByName("doctor-unmeasured").doctor(
        "doctor-unmeasured",
      );
    expect(unmeasured).not.toHaveProperty("browserIdentity");
  });

  test("reads the marked line and leaves the log to the Computer", async () => {
    // The log is the Computer's own history — GrokBot's
    // `[box-doctor] PASS|FAIL <name>: <detail>` lines in
    // `/tmp/box-doctor.log`, proven against the real script in
    // `runtime.test.ts`. The provider never reads or parses it.
    const line = reportLine([
      { name: "clock", status: "pass", detail: "the clock reads 2026-09-01" },
    ]);
    await script({ match: DOCTOR_SCRIPT, stdout: line });

    const report =
      await env.FLY_COMPATIBILITY.getByName("doctor-log").doctor("doctor-log");

    expect((report as { ok: boolean }).ok).toBe(true);
    const exec = (await calls()).find(
      (call) =>
        call.botId === "doctor-log" && call.script?.includes(DOCTOR_SCRIPT),
    );
    // The provider never parses the log; it reads the marked line. The log is
    // the Computer's own history, which is why the script owns its path.
    expect(exec!.script).not.toContain(DOCTOR_LOG);
  });

  test("answers a Computer whose output is not a report", async () => {
    await script({ match: DOCTOR_SCRIPT, stdout: "everything is fine\n" });

    const report =
      await env.FLY_COMPATIBILITY.getByName("doctor-bad").doctor("doctor-bad");

    expect(report).toMatchObject({ ok: false });
    expect((report as { message: string }).message).toContain(
      "no readable report",
    );
  });
});
