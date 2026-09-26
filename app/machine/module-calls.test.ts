import { describe, expect, test } from "bun:test";
import type { MachineModuleCallFrameV1 } from "@frockbot/core/machine-protocol";
import {
  DEVICE_NOT_CONNECTED_V1,
  MachineModuleCallsV1,
  type DeviceCallRequestV1,
} from "./module-calls.ts";
import { createMemoryMachineStorageV1 } from "./testing.ts";

const REQUEST: DeviceCallRequestV1 = {
  callId: "mc-1",
  botId: "bot-1",
  pluginId: "beeper",
  moduleId: "bridge",
  call: "send",
  input: { text: "hi" },
};

function harness(options: { candidates?: string[]; waitMs?: number } = {}): {
  calls: MachineModuleCallsV1;
  sent: Array<{ machineId: string; frame: MachineModuleCallFrameV1 }>;
  next(): Promise<{ machineId: string; frame: MachineModuleCallFrameV1 }>;
} {
  const storage = createMemoryMachineStorageV1();
  const sent: Array<{ machineId: string; frame: MachineModuleCallFrameV1 }> =
    [];
  let notify: (() => void) | undefined;
  const calls = new MachineModuleCallsV1({
    storage,
    candidates: async () => options.candidates ?? ["mac-1"],
    push: (machineId, frame) => {
      sent.push({ machineId, frame });
      notify?.();
    },
    waitMs: options.waitMs ?? 1_000,
  });
  return {
    calls,
    sent,
    next: async () => {
      while (sent.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      return sent[sent.length - 1]!;
    },
  };
}

describe("a device module call", () => {
  test("is sent to the one machine running the module and answered by its result", async () => {
    const { calls, sent, next } = harness();
    const pending = calls.call(REQUEST);
    const { machineId, frame } = await next();
    expect(machineId).toBe("mac-1");
    expect(frame).toMatchObject({
      type: "call",
      callId: "mc-1",
      pluginId: "beeper",
      moduleId: "bridge",
      call: "send",
      input: { text: "hi" },
    });
    expect(Date.parse(frame.deadline) - Date.parse(frame.serverTime)).toBe(
      1_000,
    );
    expect((await calls.claim("mac-1", "mc-1")).status).toBe("claimed");
    expect((await calls.claim("mac-1", "mc-1")).status).toBe("refused");
    expect(
      (await calls.result("mac-1", "mc-1", { ok: true, value: 7 })).status,
    ).toBe("recorded");
    expect(await pending).toEqual({ ok: true, value: 7 });

    // The same effect asked again is told the same thing and sends nothing.
    expect(await calls.call(REQUEST)).toEqual({ ok: true, value: 7 });
    expect(sent).toHaveLength(1);
    expect(
      (await calls.result("mac-1", "mc-1", { ok: true, value: 8 })).status,
    ).toBe("replayed");
  });

  test("fails at once when no machine running the module is connected", async () => {
    const { calls, sent } = harness({ candidates: [] });
    expect(await calls.call(REQUEST)).toEqual({
      ok: false,
      outcome: "failed",
      error: DEVICE_NOT_CONNECTED_V1,
    });
    expect(sent).toHaveLength(0);
  });

  test("goes to the named machine, and only if it runs the module", async () => {
    const two = harness({ candidates: ["mac-1", "mac-2"] });
    expect(await two.calls.call(REQUEST)).toMatchObject({
      ok: false,
      outcome: "failed",
      error: expect.stringContaining("mac-1, mac-2"),
    });
    const named = harness({ candidates: ["mac-1", "mac-2"], waitMs: 20 });
    void named.calls.call({ ...REQUEST, deviceId: "mac-2" });
    expect((await named.next()).machineId).toBe("mac-2");
    const absent = harness({ candidates: ["mac-1"] });
    expect(
      await absent.calls.call({ ...REQUEST, deviceId: "mac-9" }),
    ).toMatchObject({ outcome: "failed", error: DEVICE_NOT_CONNECTED_V1 });
    expect(absent.sent).toHaveLength(0);
  });

  test("never claimed by its deadline is failed, and cannot be claimed after", async () => {
    const { calls, sent } = harness({ waitMs: 20 });
    expect(await calls.call(REQUEST)).toMatchObject({
      ok: false,
      outcome: "failed",
    });
    expect((await calls.claim("mac-1", "mc-1")).status).toBe("refused");
    expect(sent).toHaveLength(1);
  });

  test("claimed and unanswered is unknown, and a late result is kept, not delivered", async () => {
    const { calls, next } = harness({ waitMs: 30 });
    const pending = calls.call(REQUEST);
    await next();
    expect((await calls.claim("mac-1", "mc-1")).status).toBe("claimed");
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, outcome: "unknown" });
    expect(
      (await calls.result("mac-1", "mc-1", { ok: true, value: "sent" })).status,
    ).toBe("late");
    // What the Turn was told does not move.
    expect(await calls.call(REQUEST)).toEqual(outcome);
  });

  test("a module's own error is failed with its words", async () => {
    const { calls, next } = harness();
    const pending = calls.call(REQUEST);
    await next();
    await calls.claim("mac-1", "mc-1");
    await calls.result("mac-1", "mc-1", { ok: false, error: "no chat" });
    expect(await pending).toEqual({
      ok: false,
      outcome: "failed",
      error: "no chat",
    });
  });

  test("a claim or result from another machine is refused", async () => {
    const { calls, next } = harness({ waitMs: 50 });
    const pending = calls.call(REQUEST);
    await next();
    expect((await calls.claim("mac-2", "mc-1")).status).toBe("refused");
    await expect(
      calls.result("mac-2", "mc-1", { ok: true, value: 1 }),
    ).rejects.toThrow("not found");
    expect(await pending).toMatchObject({ outcome: "failed" });
  });

  test("a replay of a call still waiting waits on the same record, and sends nothing more", async () => {
    const { calls, sent, next } = harness();
    const first = calls.call(REQUEST);
    await next();
    const second = calls.call(REQUEST);
    await calls.claim("mac-1", "mc-1");
    await calls.result("mac-1", "mc-1", { ok: true, value: "once" });
    expect(await first).toEqual({ ok: true, value: "once" });
    expect(await second).toEqual({ ok: true, value: "once" });
    expect(sent).toHaveLength(1);
  });
});
