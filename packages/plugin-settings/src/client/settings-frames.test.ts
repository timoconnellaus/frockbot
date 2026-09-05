import { expect, test } from "bun:test";
import type {
  SettingsChangeCommand,
  SettingsFrame,
} from "@frockbot/protocol-schemas";
import {
  createSettingsFrameClient,
  type SettingsPendingStore,
} from "./settings-frames.js";

class Store implements SettingsPendingStore {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const command: SettingsChangeCommand = {
  schemaVersion: 1,
  commandId: "save-1",
  expectedRevision: 1,
  sectionId: "profile",
  values: { name: "Tim" },
};
const frame: SettingsFrame = {
  schemaVersion: 1,
  home: "application",
  ownerId: "tim",
  revision: 1,
  title: "Settings",
  sections: [],
};

test("save survives a lost reply and reconstruction without changing its envelope", async () => {
  const store = new Store();
  let dispatches = 0;
  let effects = 0;
  const transport = {
    readSettingsFrame: async () => frame,
    changeSettings: async (
      _home: "application" | "models",
      input: SettingsChangeCommand,
    ) => {
      expect(
        [...store.values.values()].map((value) => JSON.parse(value)),
      ).toEqual([command]);
      expect(input).toEqual(command);
      if (dispatches++ === 0) {
        effects++;
        throw new Error("Reply lost");
      }
      return {
        schemaVersion: 1 as const,
        commandId: input.commandId,
        revision: 2,
        status: "applied" as const,
      };
    },
  };
  const first = createSettingsFrameClient(transport, () => "tim", store);
  await expect(first.save("application", command)).rejects.toThrow(
    "Reply lost",
  );
  const restarted = createSettingsFrameClient(transport, () => "tim", store);
  expect(restarted.pending("application")).toEqual(command);
  await expect(
    restarted.save("application", { ...command, commandId: "different" }),
  ).rejects.toThrow("pending save");
  expect(await restarted.save("application", command)).toBe("applied");
  expect(effects).toBe(1);
  expect(restarted.pending("application")).toBeUndefined();
});

test("wrong receipts remain pending, owner changes fence in-flight reads, unavailable transport never dispatches", async () => {
  const store = new Store();
  let owner = "tim";
  const client = createSettingsFrameClient(
    {
      readSettingsFrame: async () => {
        owner = "other";
        return frame;
      },
      changeSettings: async () => ({
        schemaVersion: 1,
        commandId: "wrong",
        revision: 2,
        status: "applied",
      }),
    },
    () => owner,
    store,
  );
  await expect(client.save("application", command)).rejects.toThrow(
    "receipt mismatch",
  );
  expect(client.pending("application")).toEqual(command);
  await expect(client.load("application")).rejects.toThrow("owner mismatch");
  expect(client.pending("application")).toBeUndefined();
  await expect(
    createSettingsFrameClient({}, () => "tim", store).save(
      "application",
      command,
    ),
  ).rejects.toThrow("Update FrockBot");
});
