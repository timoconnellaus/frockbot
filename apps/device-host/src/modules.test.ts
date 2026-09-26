import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MachineModuleCallFrameV1,
  MachineModuleEventReceiptV1,
  MachineModuleEventV1,
  MachineModuleReportV1,
  MachineModuleV1,
} from "@frockbot/core/machine-protocol";

import {
  MODULE_CALL_LEDGER_MAX_V1,
  MODULE_REPORT_QUEUE_MAX_V1,
  ModuleHostV1,
  type ModuleHostOptionsV1,
} from "./modules.ts";
import type {
  ModuleCallOutcomeV1,
  ModuleSupervisorSeamsV1,
} from "./supervisor.ts";

const MACHINE = `mach_${"a".repeat(20)}`;

function artifact(source: string) {
  const bytes = new TextEncoder().encode(source);
  return {
    bytes,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

function module(
  moduleId: string,
  contentHash: string,
  pluginId = "beeper",
  events: Pick<MachineModuleV1, "listening" | "lastKeys"> = {
    listening: [],
    lastKeys: {},
  },
): MachineModuleV1 {
  return {
    pluginId,
    moduleId,
    contentHash,
    size: 1,
    read: [],
    net: [],
    appleEvents: [],
    calls: [],
    events: ["message"],
    ...events,
  };
}

async function host(
  artifacts: Record<string, Uint8Array>,
  overrides: Partial<ModuleHostOptionsV1> = {},
) {
  const supportDir = await mkdtemp(join(tmpdir(), "module-host-"));
  const log: string[] = [];
  const downloads: string[] = [];
  const posted: MachineModuleReportV1[][] = [];
  const sent: MachineModuleEventV1[][] = [];
  let receipt = (
    event: MachineModuleEventV1,
  ): MachineModuleEventReceiptV1 | undefined =>
    event.key.startsWith("old")
      ? { status: "duplicate" }
      : { status: "admitted" };
  const seams = new Map<string, Omit<ModuleSupervisorSeamsV1, "spawn">>();
  let answer = 200;
  const callPosts: Array<{ path: string; body: unknown }> = [];
  let claimStatus = "claimed";
  let calls = (
    _call: string,
    _input: unknown,
    _timeoutMs: number,
  ): Promise<ModuleCallOutcomeV1> =>
    Promise.resolve({ ok: true, value: "done" });
  const modules = new ModuleHostV1({
    origin: "https://bot.example",
    supportDir,
    deno: "/Applications/FrockBot.app/Contents/Helpers/deno",
    runtime: "/Applications/FrockBot.app/Contents/Resources/device-runtime.js",
    home: "/Users/person",
    credential: () => ({ machineId: MACHINE, token: "token" }),
    appleEvents: () => Promise.reject(new Error("not available yet")),
    fetch: async (url, init) => {
      if (url.includes("/module-calls/")) {
        const path = new URL(url).pathname;
        callPosts.push({ path, body: JSON.parse(String(init?.body)) });
        const callId = decodeURIComponent(path.split("/")[5]!);
        return Response.json(
          path.endsWith("/claim")
            ? { schemaVersion: 1, status: claimStatus, callId }
            : { schemaVersion: 1, status: "recorded", callId },
        );
      }
      if (url.endsWith(`/api/machines/${MACHINE}/module-events`)) {
        const { events } = JSON.parse(String(init?.body)) as {
          events: MachineModuleEventV1[];
        };
        sent.push(events);
        if (answer !== 200) return new Response("no", { status: answer });
        return Response.json({
          schemaVersion: 1,
          receipts: events.map(receipt).filter(Boolean),
        });
      }
      if (url.endsWith("/module-reports")) {
        posted.push(
          (JSON.parse(String(init?.body)) as { reports: [] }).reports,
        );
        return new Response("{}", { status: answer });
      }
      const hash = url.slice(url.lastIndexOf("/") + 1);
      downloads.push(hash);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer token",
      );
      const bytes = artifacts[hash];
      return bytes
        ? new Response(bytes)
        : new Response("missing", { status: 404 });
    },
    supervise: (declared, paths, given) => {
      const name = `${declared.moduleId}@${declared.contentHash.slice(0, 4)}`;
      seams.set(declared.moduleId, given);
      return {
        start: () => {
          log.push(`start ${name} ${paths.code}`);
          given.report({ kind: "state", state: "running" });
        },
        stop: () => log.push(`stop ${name}`),
        call: async (call, input, timeoutMs) => {
          log.push(`call ${name} ${call} ${JSON.stringify(input)}`);
          return calls(call, input, timeoutMs);
        },
      };
    },
    ...overrides,
  });
  return {
    modules,
    supportDir,
    log,
    downloads,
    posted,
    sent,
    seams,
    receipt: (next: typeof receipt) => {
      receipt = next;
    },
    answer: (status: number) => {
      answer = status;
    },
    callPosts,
    refuseClaims: () => {
      claimStatus = "refused";
    },
    answerCalls: (next: typeof calls) => {
      calls = next;
    },
  };
}

describe("ModuleHostV1", () => {
  test("starts new modules, leaves unchanged ones, restarts a changed hash and stops a removed one", async () => {
    const one = artifact("export const calls = {};");
    const two = artifact("export const calls = { a: () => 1 };");
    const three = artifact("export const calls = { b: () => 2 };");
    const { modules, log, downloads, supportDir } = await host({
      [one.hash]: one.bytes,
      [two.hash]: two.bytes,
      [three.hash]: three.bytes,
    });

    await modules.sync([module("bridge", one.hash), module("watch", two.hash)]);
    expect(log).toEqual([
      `start bridge@${one.hash.slice(0, 4)} ${join(supportDir, "modules", `${one.hash}.js`)}`,
      `start watch@${two.hash.slice(0, 4)} ${join(supportDir, "modules", `${two.hash}.js`)}`,
    ]);
    expect(
      await readFile(join(supportDir, "modules", `${one.hash}.js`), "utf8"),
    ).toBe("export const calls = {};");
    expect(modules.entries()).toEqual([
      { pluginId: "beeper", moduleId: "bridge", state: "running" },
      { pluginId: "beeper", moduleId: "watch", state: "running" },
    ]);

    log.length = 0;
    await modules.sync([
      module("bridge", three.hash),
      module("watch", two.hash),
    ]);
    expect(log).toEqual([
      `stop bridge@${one.hash.slice(0, 4)}`,
      `start bridge@${three.hash.slice(0, 4)} ${join(supportDir, "modules", `${three.hash}.js`)}`,
    ]);

    log.length = 0;
    await modules.sync([module("bridge", three.hash)]);
    expect(log).toEqual([`stop watch@${two.hash.slice(0, 4)}`]);
    expect(modules.entries().map((entry) => entry.moduleId)).toEqual([
      "bridge",
    ]);

    // An artifact already on disk is not fetched again.
    expect(downloads).toEqual([one.hash, two.hash, three.hash]);
    modules.stopAll();
    expect(log.at(-1)).toBe(`stop bridge@${three.hash.slice(0, 4)}`);
    expect(modules.entries()).toEqual([]);
  });

  test("refuses bytes that do not match their hash, and tries again on the next list", async () => {
    const real = artifact("export const calls = {};");
    const forged = artifact("export const calls = { steal: () => 1 };");
    const served: Record<string, Uint8Array> = { [real.hash]: forged.bytes };
    const { modules, log, supportDir } = await host(served);

    await modules.sync([module("bridge", real.hash)]);
    expect(log).toEqual([]);
    expect(modules.entries()).toEqual([
      { pluginId: "beeper", moduleId: "bridge", state: "crashed" },
    ]);
    await expect(
      readFile(join(supportDir, "modules", `${real.hash}.js`)),
    ).rejects.toThrow();

    served[real.hash] = real.bytes;
    await modules.sync([module("bridge", real.hash)]);
    expect(log).toHaveLength(1);
    expect(modules.entries()[0]?.state).toBe("running");
  });

  test("keeps a module's store in its own data directory", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, supportDir } = await host({
      [one.hash]: one.bytes,
    });
    await modules.sync([module("bridge", one.hash)]);
    const store = seams.get("bridge")!.store;
    await store.set("cursor", { at: 3 });
    await store.set("other", 1);
    await store.delete("other");
    expect(await store.get("cursor")).toEqual({ at: 3 });
    expect(await store.get("missing")).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          join(supportDir, "module-data", "beeper", "bridge", "store.json"),
          "utf8",
        ),
      ),
    ).toEqual({ cursor: { at: 3 } });
  });

  test("posts reports in batches no larger than the protocol allows", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, posted } = await host({ [one.hash]: one.bytes });
    await modules.sync([module("bridge", one.hash)]);
    const report = seams.get("bridge")!.report;
    for (let index = 0; index < 119; index += 1) {
      report({ kind: "log", level: "log", text: `line ${index}` });
    }
    report({ kind: "log", level: "error", text: "x".repeat(5_000) });
    await modules.flush();
    // The running state, then the 120 lines.
    expect(posted.map((batch) => batch.length)).toEqual([50, 50, 21]);
    expect(posted[0]![0]).toEqual({
      pluginId: "beeper",
      moduleId: "bridge",
      kind: "state",
      state: "running",
    });
    const last = posted[2]!.at(-1)!;
    expect(last.kind === "log" && last.text.length).toBe(2_000);
    expect(modules.pendingReports()).toBe(0);
  });

  test("drops a batch that keeps failing, and never holds more than its bound", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, posted, answer } = await host({
      [one.hash]: one.bytes,
    });
    await modules.sync([module("bridge", one.hash)]);
    const report = seams.get("bridge")!.report;
    for (let index = 0; index < MODULE_REPORT_QUEUE_MAX_V1 + 20; index += 1) {
      report({ kind: "log", level: "log", text: `line ${index}` });
    }
    expect(modules.pendingReports()).toBe(MODULE_REPORT_QUEUE_MAX_V1);

    answer(503);
    await modules.flush();
    await modules.flush();
    expect(modules.pendingReports()).toBe(MODULE_REPORT_QUEUE_MAX_V1);
    await modules.flush();
    expect(modules.pendingReports()).toBe(MODULE_REPORT_QUEUE_MAX_V1 - 50);
    expect(posted).toHaveLength(3);

    answer(200);
    await modules.flush();
    expect(modules.pendingReports()).toBe(0);
  });

  test("sends an event only while a Routine listens, and keeps its key once the cloud has it", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, sent } = await host({ [one.hash]: one.bytes });
    await modules.sync([module("bridge", one.hash)]);
    const bridge = seams.get("bridge")!;

    // Nothing listens: nothing is sent.
    await bridge.emit("message", { text: "hi" }, "m1");
    expect(sent).toEqual([]);
    expect(await bridge.lastKey("message")).toBeUndefined();

    // A Routine starts listening; the same code keeps running.
    await modules.sync([
      module("bridge", one.hash, "beeper", {
        listening: ["message"],
        lastKeys: { message: "m0" },
      }),
    ]);
    expect(seams.get("bridge")).toBe(bridge);
    expect(await bridge.lastKey("message")).toBe("m0");

    await bridge.emit("message", { text: "hi" }, "m2");
    expect(sent).toEqual([
      [
        {
          pluginId: "beeper",
          moduleId: "bridge",
          event: "message",
          key: "m2",
          payload: { text: "hi" },
        },
      ],
    ]);
    expect(await bridge.lastKey("message")).toBe("m2");
    // A replay the cloud already has is settled all the same.
    await bridge.emit("message", {}, "old-1");
    expect(await bridge.lastKey("message")).toBe("old-1");
  });

  test("batches a burst within the protocol's bound", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, sent } = await host({ [one.hash]: one.bytes });
    await modules.sync([
      module("bridge", one.hash, "beeper", {
        listening: ["message"],
        lastKeys: {},
      }),
    ]);
    const bridge = seams.get("bridge")!;
    await Promise.all(
      Array.from({ length: 45 }, (_, index) =>
        bridge.emit("message", { index }, `m${index}`),
      ),
    );
    // The first goes alone; the rest waited behind it.
    expect(sent.map((batch) => batch.length)).toEqual([1, 20, 20, 4]);
    expect(await bridge.lastKey("message")).toBe("m44");
  });

  test("fails an emit the cloud did not take, and reports one it dropped", async () => {
    const one = artifact("export const calls = {};");
    const { modules, seams, posted, sent, answer, receipt } = await host({
      [one.hash]: one.bytes,
    });
    await modules.sync([
      module("bridge", one.hash, "beeper", {
        listening: ["message"],
        lastKeys: { message: "m0" },
      }),
    ]);
    const bridge = seams.get("bridge")!;

    await expect(
      bridge.emit("message", "x".repeat(70 * 1_024), "m1"),
    ).rejects.toThrow("payload exceeds");
    expect(sent).toEqual([]);

    answer(503);
    await expect(bridge.emit("message", {}, "m1")).rejects.toThrow(
      "the event could not be sent: module events answered 503",
    );
    expect(await bridge.lastKey("message")).toBe("m0");

    answer(200);
    receipt(() => undefined);
    await expect(bridge.emit("message", {}, "m1")).rejects.toThrow(
      "a different number of events",
    );

    receipt(() => ({ status: "dropped", reason: "no such event" }));
    await bridge.emit("message", {}, "m2");
    expect(await bridge.lastKey("message")).toBe("m0");
    await modules.flush();
    expect(posted.flat().at(-1)).toEqual({
      pluginId: "beeper",
      moduleId: "bridge",
      kind: "log",
      level: "error",
      text: 'the cloud dropped event "message": no such event',
    });
  });
});

describe("a Plugin's call to a module", () => {
  const serverTime = "2026-09-01T00:00:00.000Z";
  function frame(
    callId: string,
    deadlineMs = 10_000,
  ): MachineModuleCallFrameV1 {
    return {
      type: "call",
      callId,
      pluginId: "beeper",
      moduleId: "bridge",
      call: "send",
      input: { text: "hi" },
      deadline: new Date(Date.parse(serverTime) + deadlineMs).toISOString(),
      serverTime,
    };
  }

  test("is claimed, run once, and answered, however often it arrives", async () => {
    const one = artifact("export const calls = {};");
    const { modules, log, callPosts, supportDir } = await host({
      [one.hash]: one.bytes,
    });
    await modules.sync([module("bridge", one.hash)]);
    await modules.handleCall(frame("mc-1"));
    await modules.handleCall(frame("mc-1"));
    expect(log.filter((line) => line.startsWith("call"))).toEqual([
      `call bridge@${one.hash.slice(0, 4)} send {"text":"hi"}`,
    ]);
    expect(callPosts).toEqual([
      {
        path: `/api/machines/${MACHINE}/module-calls/mc-1/claim`,
        body: {},
      },
      {
        path: `/api/machines/${MACHINE}/module-calls/mc-1/result`,
        body: { ok: true, value: "done" },
      },
    ]);
    // A host restarted with the same folder still remembers it.
    const again = await host({ [one.hash]: one.bytes }, { supportDir });
    await again.modules.sync([module("bridge", one.hash)]);
    await again.modules.handleCall(frame("mc-1"));
    expect(again.callPosts).toEqual([]);
    expect(
      JSON.parse(await readFile(join(supportDir, "module-calls.json"), "utf8")),
    ).toEqual(["mc-1"]);
  });

  test("is refused past its deadline, and not run when the claim is refused", async () => {
    const one = artifact("export const calls = {};");
    const { modules, log, callPosts, refuseClaims } = await host({
      [one.hash]: one.bytes,
    });
    await modules.sync([module("bridge", one.hash)]);
    await modules.handleCall(frame("mc-late", 0));
    expect(callPosts).toEqual([]);
    refuseClaims();
    await modules.handleCall(frame("mc-2"));
    expect(callPosts.map((post) => post.path)).toEqual([
      `/api/machines/${MACHINE}/module-calls/mc-2/claim`,
    ]);
    expect(log.some((line) => line.startsWith("call"))).toBe(false);
  });

  test("runs under what is left of its deadline, and answers a module that is not running", async () => {
    const one = artifact("export const calls = {};");
    const { modules, callPosts, answerCalls } = await host({
      [one.hash]: one.bytes,
    });
    let given = 0;
    answerCalls(async (_call, _input, timeoutMs) => {
      given = timeoutMs;
      return { ok: false, error: "no chat" };
    });
    await modules.sync([module("bridge", one.hash)]);
    await modules.handleCall(frame("mc-3", 5_000), Date.now() - 1_000);
    expect(given).toBeGreaterThan(3_900);
    expect(given).toBeLessThanOrEqual(4_000);
    expect(callPosts.at(-1)?.body).toEqual({ ok: false, error: "no chat" });

    await modules.handleCall({ ...frame("mc-4"), moduleId: "absent" });
    expect(callPosts.at(-1)?.body).toEqual({
      ok: false,
      error: "the module is not running on this computer",
    });
  });

  test("keeps a bounded ledger", async () => {
    const { modules, supportDir } = await host({});
    for (let index = 0; index < 3; index += 1) {
      await modules.handleCall({ ...frame(`mc-${index}`), moduleId: "absent" });
    }
    const kept = JSON.parse(
      await readFile(join(supportDir, "module-calls.json"), "utf8"),
    ) as string[];
    expect(kept).toEqual(["mc-0", "mc-1", "mc-2"]);
    expect(MODULE_CALL_LEDGER_MAX_V1).toBeGreaterThan(100);
  });
});
