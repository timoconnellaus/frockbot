import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ModuleSupervisorV1,
  type ModuleDeclarationV1,
  type ModuleReportV1,
} from "./supervisor.ts";

const RUNTIME = join(import.meta.dir, "runtime.ts");

const running: ModuleSupervisorV1[] = [];
afterEach(() => {
  for (const supervisor of running.splice(0)) supervisor.stop();
});

async function supervise(
  source: string,
  declaration: Partial<ModuleDeclarationV1> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "module-"));
  const code = join(directory, "module.ts");
  await writeFile(code, source, "utf8");
  const reports: ModuleReportV1[] = [];
  const emitted: unknown[][] = [];
  const store = new Map<string, unknown>();
  const scripts: string[] = [];
  let restarted = 0;
  const supervisor = new ModuleSupervisorV1(
    {
      calls: ["echo", "fail", "emit", "count", "script", "wait"],
      events: ["message"],
      appleEvents: ["com.apple.iChat"],
      ...declaration,
    },
    {
      spawn: () => spawn(process.execPath, [RUNTIME, code]),
      emit: async (...args) => {
        emitted.push(args);
      },
      lastKey: async () => "k-1",
      store: {
        get: async (key) => store.get(key),
        set: async (key, value) => {
          store.set(key, value);
        },
        delete: async (key) => {
          store.delete(key);
        },
      },
      appleEvents: async (bundleId, script) => {
        scripts.push(`${bundleId}:${script}`);
        return "ok";
      },
      report: (report) => reports.push(report),
      delay: async () => {
        restarted += 1;
      },
    },
  );
  running.push(supervisor);
  supervisor.start();
  return {
    supervisor,
    reports,
    emitted,
    store,
    scripts,
    restarts: () => restarted,
  };
}

const MODULE = `
export const calls = {
  echo: (input) => ({ echoed: input }),
  fail: () => { throw new Error("nope"); },
  emit: async (_input, context) => {
    await context.emit("message", { text: "hi" }, { key: "m-1" });
    return context.lastKey("message");
  },
  count: async (_input, context) => {
    const next = ((await context.store.get("n")) ?? 0) + 1;
    await context.store.set("n", next);
    console.log("counted", next);
    return next;
  },
  script: (bundleId, context) => context.appleEvents.run(bundleId, "tell app"),
  wait: () => new Promise(() => {}),
};
`;

describe("a supervised module", () => {
  test("answers its calls, and a thrown error is the call's error", async () => {
    const { supervisor } = await supervise(MODULE);
    expect(await supervisor.call("echo", { a: 1 }, 5_000)).toEqual({
      ok: true,
      value: { echoed: { a: 1 } },
    });
    expect(await supervisor.call("fail", null, 5_000)).toEqual({
      ok: false,
      error: "nope",
    });
  });

  test("refuses a call it did not declare, and one it does not export", async () => {
    const { supervisor } = await supervise(MODULE, {
      calls: ["echo", "missing"],
    });
    expect(await supervisor.call("fail", null, 5_000)).toMatchObject({
      ok: false,
      error: 'the module declares no call "fail"',
    });
    expect(await supervisor.call("missing", null, 5_000)).toMatchObject({
      ok: false,
      error: 'the module exports no call "missing"',
    });
  });

  test("emits only declared events, and reads its last key", async () => {
    const { supervisor, emitted } = await supervise(MODULE);
    expect(await supervisor.call("emit", null, 5_000)).toEqual({
      ok: true,
      value: "k-1",
    });
    expect(emitted).toEqual([["message", { text: "hi" }, "m-1"]]);
    const refused = await supervise(MODULE, { events: [] });
    expect(await refused.supervisor.call("emit", null, 5_000)).toMatchObject({
      ok: false,
      error: 'the module declares no event "message"',
    });
  });

  test("keeps its own store, and its console becomes log reports", async () => {
    const { supervisor, reports } = await supervise(MODULE);
    await supervisor.call("count", null, 5_000);
    expect(await supervisor.call("count", null, 5_000)).toEqual({
      ok: true,
      value: 2,
    });
    expect(reports).toContainEqual({
      kind: "log",
      level: "log",
      text: "counted 2",
    });
  });

  test("scripts only the applications it named", async () => {
    const { supervisor, scripts } = await supervise(MODULE);
    expect(await supervisor.call("script", "com.apple.iChat", 5_000)).toEqual({
      ok: true,
      value: "ok",
    });
    expect(
      await supervisor.call("script", "com.apple.mail", 5_000),
    ).toMatchObject({
      ok: false,
      error: 'the module declares no Apple Events to "com.apple.mail"',
    });
    expect(scripts).toEqual(["com.apple.iChat:tell app"]);
  });

  test("a call past its deadline fails, and the module keeps running", async () => {
    const { supervisor } = await supervise(MODULE);
    expect(await supervisor.call("wait", null, 100)).toMatchObject({
      ok: false,
      error: "the module did not answer within 100ms",
    });
    expect(await supervisor.call("echo", 1, 5_000)).toMatchObject({ ok: true });
  });

  test("a module that dies is reported and started again", async () => {
    const { supervisor, reports, restarts } = await supervise(
      `
      export const calls = { die: () => process.exit(3) };
    `,
      { calls: ["die"] },
    );
    expect(await supervisor.call("die", null, 5_000)).toMatchObject({
      ok: false,
      error: "the module stopped",
    });
    await Bun.sleep(200);
    expect(reports).toContainEqual(
      expect.objectContaining({ kind: "state", state: "crashed" }),
    );
    expect(restarts()).toBe(1);
    expect(
      reports.filter(
        (report) => report.kind === "state" && report.state === "running",
      ),
    ).toHaveLength(2);
  });

  test("a module that will not load says why", async () => {
    const { reports } = await supervise(`throw new Error("broken at import");`);
    await Bun.sleep(300);
    expect(reports).toContainEqual({
      kind: "log",
      level: "error",
      text: "the module failed to load: broken at import",
    });
  });
});
