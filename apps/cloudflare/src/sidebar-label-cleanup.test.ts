import { describe, expect, test } from "bun:test";
import { decodeBotSettingsViewV1 } from "@frockbot/core/configuration";
import { RUN_PREFIX } from "@frockbot/core/durable";
import { isProtocolValue } from "@frockbot/core/protocol-schemas";
import {
  cleanBotLabelV1,
  cleanGroupChatLabelsV1,
} from "./sidebar-label-cleanup.js";

function storageFrom(initial: Record<string, unknown>) {
  const held = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    held,
    writes,
    get: async (key: string) => held.get(key),
    put: async (key: string, value: unknown) => {
      writes.push(key);
      held.set(key, structuredClone(value));
    },
    list: async (options: {
      prefix?: string;
      limit?: number;
      start?: string;
    }) => {
      const entries = [...held.entries()]
        .filter(([key]) => {
          if (options.prefix && !key.startsWith(options.prefix)) return false;
          if (options.start !== undefined && key < options.start) return false;
          return true;
        })
        .sort(([left], [right]) => left.localeCompare(right));
      const limited =
        options.limit === undefined ? entries : entries.slice(0, options.limit);
      return new Map(limited);
    },
  };
}

function settings(profile: Record<string, unknown>, revision = 4) {
  return {
    schemaVersion: 1,
    botId: "housework",
    revision,
    profile,
    notifications: { enabled: true },
    packageValues: {},
  };
}

function run(runId: string, profile: Record<string, unknown>) {
  return {
    runId,
    status: "completed",
    configurationSnapshot: settings(profile),
    preparedInputs: {
      schemaVersion: 1,
      bot: { revision: 4, settings: settings(profile) },
    },
  };
}

const labelled = { name: "Housework", label: "Home", sidebarOrder: 1000 };
const plain = { name: "Housework", sidebarOrder: 1000 };

describe("Bot label cleanup", () => {
  test("strips the label from the settings and from every run, once", async () => {
    const runs = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => {
        const runId = `run-${String(index).padStart(2, "0")}`;
        return [`${RUN_PREFIX}${runId}`, run(runId, labelled)];
      }),
    );
    const storage = storageFrom({
      "bot-configuration": settings(labelled),
      ...runs,
    });
    await cleanBotLabelV1(storage);

    // The revision moves, so an open settings surface fences on what it reads.
    expect(storage.held.get("bot-configuration")).toEqual(settings(plain, 5));
    expect(() =>
      decodeBotSettingsViewV1(storage.held.get("bot-configuration")),
    ).not.toThrow();
    // Past a page of runs, every one of them loses both copies.
    for (const [key, stored] of storage.held) {
      if (!key.startsWith(RUN_PREFIX)) continue;
      expect(stored).toEqual(run(key.slice(RUN_PREFIX.length), plain));
    }

    storage.held.set("bot-configuration", settings(labelled));
    await cleanBotLabelV1(storage);
    expect(storage.held.get("bot-configuration")).toEqual(settings(labelled));
  });

  test("writes nothing but its receipt for a Bot that never had a label", async () => {
    const storage = storageFrom({
      "bot-configuration": settings(plain),
      [`${RUN_PREFIX}one`]: run("one", plain),
      [`${RUN_PREFIX}bare`]: { runId: "bare", status: "failed" },
    });
    await cleanBotLabelV1(storage);
    expect(storage.writes).toEqual([
      "maintenance:bot-label-removal:2026-09-25",
    ]);
  });
});

const group = {
  schemaVersion: 1,
  groupId: "g-0123456789abcdef0123",
  members: ["general", "xero"],
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
  pinnedAt: "2026-09-23T10:00:00.000Z",
};
const other = { ...group, groupId: "g-99999999999999999999" };

describe("Group Chat label cleanup", () => {
  test("strips the label from the list and the receipts that replay a group", async () => {
    const receipt = (value: unknown) => ({
      schemaVersion: 1,
      fingerprint: "{}",
      result: {
        receipt: {
          schemaVersion: 1,
          commandId: "arrange-1",
          groupId: group.groupId,
          status: "applied",
          group: value,
          revision: 3,
        },
        change: { kind: "event", context: { schemaVersion: 1, group: value } },
      },
    });
    const storage = storageFrom({
      "group-chat:list:v1": {
        schemaVersion: 1,
        revision: 3,
        groups: [{ ...group, label: "Work" }, other],
      },
      "group-chat:receipt:arrange-1": receipt({ ...group, label: "Work" }),
      "group-chat:receipt:create-1": receipt(other),
    });
    await cleanGroupChatLabelsV1(storage);

    const list = storage.held.get("group-chat:list:v1");
    expect(list).toEqual({
      schemaVersion: 1,
      revision: 4,
      groups: [group, other],
    });
    expect(isProtocolValue("GroupChatList", list)).toBe(true);
    expect(storage.held.get("group-chat:receipt:arrange-1")).toEqual(
      receipt(group),
    );
    expect(storage.writes).not.toContain("group-chat:receipt:create-1");

    const relabelled = {
      schemaVersion: 1,
      revision: 4,
      groups: [{ ...group, label: "Work" }],
    };
    storage.held.set("group-chat:list:v1", relabelled);
    await cleanGroupChatLabelsV1(storage);
    expect(storage.held.get("group-chat:list:v1")).toEqual(relabelled);
  });

  test("leaves an account without Group Chats as it was", async () => {
    const storage = storageFrom({});
    await cleanGroupChatLabelsV1(storage);
    expect(storage.writes).toEqual([
      "maintenance:group-label-removal:2026-09-25",
    ]);
  });
});
