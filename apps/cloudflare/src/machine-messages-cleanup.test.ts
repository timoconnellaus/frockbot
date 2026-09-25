import { expect, test } from "bun:test";
import {
  cleanBotMachineMessagesV1,
  cleanUserMachineMessagesV1,
  withoutMessagesCapabilityV1,
  type MachineMessagesCleanupStorageV1,
} from "./machine-messages-cleanup.js";

function fixture(entries: [string, unknown][]) {
  const values = new Map(entries);
  const storage: MachineMessagesCleanupStorageV1 = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async list<T>(options: {
      prefix: string;
      limit: number;
      startAfter?: string;
    }) {
      const keys = [...values.keys()]
        .filter(
          (key) =>
            key.startsWith(options.prefix) &&
            (options.startAfter === undefined || key > options.startAfter),
        )
        .sort()
        .slice(0, options.limit);
      return new Map(keys.map((key) => [key, values.get(key) as T]));
    },
  };
  return { values, storage };
}

const machine = {
  schemaVersion: 1,
  machineId: "mac-1",
  label: "Mac",
  platform: "macos",
  capabilities: ["exec", "messages"],
  messagesPermissions: {
    schemaVersion: 1,
    fullDiskAccess: true,
    automation: true,
    checkedAt: "2026-09-01T00:00:00.000Z",
  },
};

test("drops the capability and the report, and leaves other records alone", () => {
  const { messagesPermissions: _dropped, ...rest } = machine;
  expect(withoutMessagesCapabilityV1(machine)).toEqual({
    ...rest,
    capabilities: ["exec"],
  });
  expect(
    withoutMessagesCapabilityV1({ ...rest, capabilities: ["exec"] }),
  ).toBeUndefined();
});

test("the User object rewrites machines and drops Messages commands once", async () => {
  const messagesCommand = {
    commandId: "c-1",
    op: { kind: "messages", call: { kind: "activity", limit: 5 } },
  };
  const execCommand = {
    commandId: "c-2",
    op: { kind: "exec", command: "ls", timeoutMs: 1, maxOutputBytes: 1 },
  };
  const { values, storage } = fixture([
    ["machine:mac-1", machine],
    ["machine-queue:mac-1:0001", messagesCommand],
    ["machine-queue:mac-1:0002", execCommand],
    ["machine-requeue:c-1", 1],
    ["machine-result:c-1", { commandId: "c-1" }],
  ]);
  await cleanUserMachineMessagesV1(storage, new Date(0));
  expect(values.get("machine:mac-1")).toMatchObject({ capabilities: ["exec"] });
  expect(values.get("machine:mac-1")).not.toHaveProperty("messagesPermissions");
  expect(values.has("machine-queue:mac-1:0001")).toBe(false);
  expect(values.has("machine-requeue:c-1")).toBe(false);
  expect(values.get("machine-queue:mac-1:0002")).toEqual(execCommand);
  expect(values.has("machine-result:c-1")).toBe(true);

  // The receipt makes a second load free, even if a shape reappeared.
  values.set("machine:mac-2", { ...machine, machineId: "mac-2" });
  await cleanUserMachineMessagesV1(storage);
  expect(values.get("machine:mac-2")).toHaveProperty("messagesPermissions");
});

test("the Bot drops its Messages intents and keeps the rest", async () => {
  const { values, storage } = fixture([
    [
      "machine-command:a",
      { op: { kind: "messages", call: { kind: "check-permissions" } } },
    ],
    ["machine-command:b", { op: { kind: "read", path: "/x", maxBytes: 1 } }],
  ]);
  await cleanBotMachineMessagesV1(storage);
  expect(values.has("machine-command:a")).toBe(false);
  expect(values.has("machine-command:b")).toBe(true);
});

test("walks past a full page", async () => {
  const entries: [string, unknown][] = Array.from({ length: 300 }, (_, i) => [
    `machine-command:${String(i).padStart(4, "0")}`,
    { op: { kind: "messages", call: { kind: "check-permissions" } } },
  ]);
  const { values, storage } = fixture(entries);
  await cleanBotMachineMessagesV1(storage);
  expect(
    [...values.keys()].filter((key) => key.startsWith("machine-command:")),
  ).toEqual([]);
});
