import { describe, expect, test } from "bun:test";
import {
  auditEntryForDeviceUseV1,
  decodeDeviceUseCommandV1,
  decodeDeviceUseV1,
  DEVICE_USE_LOG_KEY_V1,
  DeviceUseLogV1,
  type DeviceUseV1,
} from "./device.js";
import { decodeAuditEntryV1 } from "./shared.js";

const USE: DeviceUseV1 = {
  useId: "nAbCdEf_1234-5678",
  pluginId: "tuner",
  surfaceId: "tuner",
  ability: "microphone",
  device: "web",
  startedAt: "2026-09-24T05:00:00.000Z",
  endedAt: "2026-09-24T05:02:14.000Z",
  ending: "stopped",
};

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

describe("a device use the client reports", () => {
  test("decodes exactly, and ends after it starts", () => {
    expect(decodeDeviceUseCommandV1({ schemaVersion: 1, ...USE })).toEqual(USE);
    expect(() => decodeDeviceUseCommandV1(USE)).toThrow(/schemaVersion/);
    expect(() => decodeDeviceUseV1({ ...USE, extra: 1 })).toThrow(
      /invalid fields/,
    );
    expect(() => decodeDeviceUseV1({ ...USE, ability: "camera" })).toThrow(
      /ability/,
    );
    expect(() => decodeDeviceUseV1({ ...USE, ending: "gone" })).toThrow(
      /ending/,
    );
    expect(() => decodeDeviceUseV1({ ...USE, device: "Web" })).toThrow(
      /device/,
    );
    expect(() => decodeDeviceUseV1({ ...USE, useId: "short" })).toThrow(
      /useId/,
    );
    expect(() =>
      decodeDeviceUseV1({ ...USE, endedAt: "2026-09-24T04:59:59.000Z" }),
    ).toThrow(/end after/);
    expect(() =>
      decodeDeviceUseV1({ ...USE, endedAt: "2026-09-26T05:00:00.000Z" }),
    ).toThrow(/end after/);
  });

  test("becomes one row naming the Plugin, the ability, the device and how long", async () => {
    const entry = await auditEntryForDeviceUseV1("bot-1", USE, "Tuner");
    expect(entry).toMatchObject({
      botId: "bot-1",
      runId: `device:${USE.useId}`,
      occurrenceId: `device:${USE.useId}`,
      turn: 0,
      step: 0,
      ordinal: 0,
      effectId: USE.useId,
      at: USE.startedAt,
      kind: "device",
      target: "device:web",
      toolName: "microphone",
      preview: "Tuner used the microphone",
      outcome: "ok",
      durationMs: 134_000,
    });
    expect(
      (
        await auditEntryForDeviceUseV1(
          "bot-1",
          { ...USE, ending: "taken" },
          "Tuner",
        )
      ).outcome,
    ).toBe("interrupted");
    expect(
      (
        await auditEntryForDeviceUseV1(
          "bot-1",
          { ...USE, ending: "failed" },
          "Tuner",
        )
      ).outcome,
    ).toBe("error");
  });
});

describe("an audit entry for a device use", () => {
  test("has no Turn, and only a device target; a tool call has neither", async () => {
    const entry = await auditEntryForDeviceUseV1("bot-1", USE, "Tuner");
    expect(decodeAuditEntryV1(entry)).toEqual(entry);
    expect(() => decodeAuditEntryV1({ ...entry, runId: "run-1" })).toThrow(
      /use id/,
    );
    expect(() => decodeAuditEntryV1({ ...entry, target: "computer" })).toThrow(
      /target/,
    );
    expect(() => decodeAuditEntryV1({ ...entry, turn: 1 })).toThrow(
      /coordinates/,
    );
    expect(() =>
      decodeAuditEntryV1({
        ...entry,
        kind: "shell",
        occurrenceId: "tool:1:1:0",
        runId: "run-1",
        turn: 1,
        step: 1,
      }),
    ).toThrow(/target/);
  });
});

describe("the Bot's record of device uses", () => {
  test("keeps one row per use, newest last, within its bound", async () => {
    const storage = new MemoryStorage();
    const log = new DeviceUseLogV1(storage, 2);
    const row = (useId: string) =>
      auditEntryForDeviceUseV1("bot-1", { ...USE, useId }, "Tuner");
    expect(await log.record(await row("use-aaaaaaaa"))).toBe(true);
    expect(await log.record(await row("use-aaaaaaaa"))).toBe(false);
    expect(await log.record(await row("use-bbbbbbbb"))).toBe(true);
    expect(await log.record(await row("use-cccccccc"))).toBe(true);
    expect((await log.entries()).map((entry) => entry.effectId)).toEqual([
      "use-bbbbbbbb",
      "use-cccccccc",
    ]);
    expect(storage.values.has(DEVICE_USE_LOG_KEY_V1)).toBe(true);
  });
});
