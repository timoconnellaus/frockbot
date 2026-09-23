import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/core/configuration";
import {
  cleanUndecodableConnectCatalogsV1,
  CONNECT_CATALOG_DISCLOSURE_MAX_AGE_MS_V1,
  CONNECT_CATALOG_REFRESH_AFTER_MS_V1,
  connectCatalogBodyKeyV1,
  connectCatalogContentHashV1,
  connectCatalogDirectoryKeyV1,
  connectCatalogJobKeyV1,
  publishConnectCatalogV1,
  type ConnectCatalogStorageV1,
} from "./account-catalog.js";
import type { ConnectToolV1 } from "./composio.js";
import { ConnectUserBackendContribution } from "./user.js";

const TOOL: ConnectToolV1 = {
  slug: "GMAIL_SEND_EMAIL",
  name: "send_email",
  description: "Sends an email.",
  inputSchema: { type: "object", properties: { to: { type: "string" } } },
  version: "20250930_00",
};

class Memory implements ConnectCatalogStorageV1 {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  list<T>(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    for (const [key, value] of [...this.values].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.start && key < options.start) continue;
      found.set(key, value as T);
      if (options.limit && found.size >= options.limit) break;
    }
    return Promise.resolve(found);
  }
  transaction<T>(
    callback: (tx: ConnectCatalogStorageV1) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }
  setAlarm(time: number): Promise<void> {
    this.alarm = time;
    return Promise.resolve();
  }
}

function connection(generation = "g1"): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "connect",
    connectionTypeId: "connect-gmail",
    displayName: "Gmail",
    state: "ready",
    generation,
    safeMetadata: {
      toolkitSlug: "gmail",
      toolkitName: "Gmail",
      connectedAccountId: "ca_1",
      namespace: "gmail",
      startedAt: "2026-09-22T00:00:00.000Z",
    },
  };
}

function harness(options?: {
  tools?: ConnectToolV1[];
  delayMs?: number;
  generation?: string;
}) {
  const storage = new Memory();
  storage.values.set("user-id", "tim");
  const settings = {
    connections: [connection(options?.generation ?? "g1")],
    async getConnection(
      _userId: string,
      connectionId: string,
    ): Promise<ConnectionView | undefined> {
      return this.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
    },
    async readSnapshot() {
      return { connections: this.connections };
    },
  };
  let fetches = 0;
  const client = {
    listTools: async () => {
      fetches += 1;
      if (options?.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return options?.tools ?? [TOOL];
    },
  };
  const now = { value: Date.parse("2026-09-22T00:00:00.000Z") };
  const contribution = new ConnectUserBackendContribution({
    storage: storage as never,
    settings: settings as never,
    client: client as never,
    now: () => now.value,
  });
  return { storage, settings, contribution, fetches: () => fetches, now };
}

describe("account tool catalogs", () => {
  test("the first directory read fetches the catalog once; later reads do not", async () => {
    const { contribution, fetches } = harness();
    const read = () =>
      contribution.readToolCatalog({
        userId: "tim",
        connectionId: "connection-1",
        generation: "g1",
      });
    const listed = await read();
    expect(listed).toEqual({
      kind: "directory",
      tools: [{ name: "send_email", description: "Sends an email." }],
    });
    await read();
    expect(fetches()).toBe(1);
  });

  test("a large catalog is stored in chunks and one tool is read from its own", async () => {
    const schema = {
      type: "object",
      properties: { body: { type: "string", description: "x".repeat(20_000) } },
    };
    const tools = Array.from({ length: 120 }, (_, index) => ({
      ...TOOL,
      slug: `GMAIL_TOOL_${index}`,
      name: `tool_${index}`,
      inputSchema: schema,
    }));
    const { contribution, storage } = harness({ tools });
    const answer = await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "tool_119",
    });
    expect(answer.kind).toBe("catalog");
    if (answer.kind === "catalog") {
      expect(answer.catalog.tools.map((tool) => tool.name)).toEqual([
        "tool_119",
      ]);
    }
    const chunks = [...storage.values.keys()].filter((key) =>
      key.startsWith("connect:tool-catalog:v1:body:connection-1:"),
    );
    expect(chunks.length).toBeGreaterThan(1);
    const missing = await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "fly",
    });
    expect(missing.kind).toBe("unavailable");
    if (missing.kind === "unavailable") {
      expect(missing.message).toContain('no tool named "fly"');
    }
  });

  test("two first disclosures share one fetch and a later Turn keeps its pin", async () => {
    const { contribution, fetches, storage } = harness();
    const [first, second] = await Promise.all([
      contribution.readToolCatalog({
        userId: "tim",
        connectionId: "connection-1",
        generation: "g1",
        toolName: "send_email",
        firstUseMs: 5_000,
      }),
      contribution.readToolCatalog({
        userId: "tim",
        connectionId: "connection-1",
        generation: "g1",
        toolName: "send_email",
        firstUseMs: 5_000,
      }),
    ]);
    expect(fetches()).toBe(1);
    expect(first.kind).toBe("catalog");
    expect(second).toEqual(first);
    const pinned = structuredClone(first);
    const again = await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "send_email",
    });
    expect(fetches()).toBe(1);
    expect(again).toEqual(pinned);
    const job = storage.values.get(connectCatalogJobKeyV1("connection-1")) as {
      dueAt: number;
    };
    expect(job.dueAt).toBe(
      Date.parse("2026-09-22T00:00:00.000Z") +
        CONNECT_CATALOG_REFRESH_AFTER_MS_V1,
    );
    expect(storage.alarm).toBe(Date.parse("2026-09-22T00:00:00.000Z"));
  });

  test("a generation change does not publish the fetch that started before it", async () => {
    const { contribution, settings, storage } = harness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ConnectUserBackendContribution({
      storage: storage as never,
      settings: settings as never,
      client: {
        listTools: async () => {
          await gate;
          return [TOOL];
        },
      } as never,
      now: () => Date.parse("2026-09-22T00:00:00.000Z"),
    });
    const pending = slow.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "send_email",
      firstUseMs: 5_000,
    });
    settings.connections[0] = connection("g2");
    release!();
    const answer = await pending;
    expect(answer.kind).toBe("unavailable");
    expect(
      storage.values.get(connectCatalogDirectoryKeyV1("connection-1")),
    ).toBeUndefined();
  });

  test("a failed refresh keeps the last catalog and revocation blocks disclosure", async () => {
    const { contribution, storage, now, settings } = harness();
    await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "send_email",
    });
    const published = storage.values.get(
      connectCatalogDirectoryKeyV1("connection-1"),
    );
    const job = storage.values.get(connectCatalogJobKeyV1("connection-1")) as {
      dueAt: number;
    };
    job.dueAt = now.value;
    const failing = new ConnectUserBackendContribution({
      storage: storage as never,
      settings: settings as never,
      client: {
        listTools: async () => {
          throw new Error("provider down");
        },
      } as never,
      now: () => now.value,
    });
    await failing.alarm();
    const directory = storage.values.get(
      connectCatalogDirectoryKeyV1("connection-1"),
    ) as { status: string; tools: unknown[]; refreshError?: string };
    expect(directory.status).toBe("ready");
    expect(directory.tools).toEqual((published as { tools: unknown[] }).tools);
    expect(directory.refreshError).toContain("provider down");
    settings.connections[0] = { ...connection(), state: "revoked" };
    const revoked = await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "send_email",
    });
    expect(revoked.kind).toBe("stale-contract");
    expect(
      storage.values.has(
        connectCatalogBodyKeyV1(
          "connection-1",
          connectCatalogContentHashV1([TOOL]),
          0,
        ),
      ),
    ).toBe(true);
  });

  test("a catalog older than a day is not disclosed until a refresh succeeds", async () => {
    const { storage, settings, now } = harness();
    await publishConnectCatalogV1(storage, {
      connectionId: "connection-1",
      generation: "g1",
      toolkitSlug: "gmail",
      namespace: "gmail",
      tools: [TOOL],
      now: now.value,
      readConnection: async () => settings.connections[0],
    });
    now.value += CONNECT_CATALOG_DISCLOSURE_MAX_AGE_MS_V1;
    let fetches = 0;
    const contribution = new ConnectUserBackendContribution({
      storage: storage as never,
      settings: settings as never,
      client: {
        listTools: async () => {
          fetches += 1;
          return [{ ...TOOL, version: "next" }];
        },
      } as never,
      now: () => now.value,
    });
    const disclosed = await contribution.readToolCatalog({
      userId: "tim",
      connectionId: "connection-1",
      generation: "g1",
      toolName: "send_email",
      firstUseMs: 5_000,
    });
    expect(fetches).toBe(1);
    expect(disclosed.kind).toBe("catalog");
    if (disclosed.kind === "catalog") {
      expect(disclosed.catalog.tools[0]?.version).toBe("next");
    }
  });

  test("an earlier User alarm is not moved back by a catalog deadline", async () => {
    const storage = new Memory();
    storage.alarm = 1_000;
    const jobDue = 1_000 + CONNECT_CATALOG_REFRESH_AFTER_MS_V1;
    const { commitConnectCatalogJobV1 } = await import("./account-catalog.js");
    await commitConnectCatalogJobV1(storage, {
      schemaVersion: 1,
      connectionId: "connection-1",
      generation: "g1",
      toolkitSlug: "gmail",
      namespace: "gmail",
      dueAt: jobDue,
      attempts: 0,
    });
    expect(storage.alarm).toBe(1_000);
    expect(storage.values.has(connectCatalogJobKeyV1("connection-1"))).toBe(
      true,
    );
  });

  test("malformed catalog records are deleted once", async () => {
    const storage = new Memory();
    storage.values.set(connectCatalogDirectoryKeyV1("connection-1"), {
      schemaVersion: 1,
      broken: true,
    });
    storage.values.set("turn-pin", { catalog: TOOL });
    await cleanUndecodableConnectCatalogsV1(storage);
    await cleanUndecodableConnectCatalogsV1(storage);
    expect(
      storage.values.has(connectCatalogDirectoryKeyV1("connection-1")),
    ).toBe(false);
    expect(storage.values.get("turn-pin")).toEqual({ catalog: TOOL });
  });

  test("an oversize catalog is refused without replacing a valid one", async () => {
    const huge = "x".repeat(1_100_000);
    const { contribution, storage } = harness({
      tools: [{ ...TOOL, description: huge }],
    });
    await publishConnectCatalogV1(storage, {
      connectionId: "connection-1",
      generation: "g1",
      toolkitSlug: "gmail",
      namespace: "gmail",
      tools: [TOOL],
      now: Date.parse("2026-09-22T00:00:00.000Z"),
      readConnection: async () => connection(),
    });
    const job = storage.values.get(connectCatalogJobKeyV1("connection-1")) as {
      dueAt: number;
    };
    job.dueAt = Date.parse("2026-09-22T00:00:00.000Z");
    await contribution.alarm();
    const directory = storage.values.get(
      connectCatalogDirectoryKeyV1("connection-1"),
    ) as { contentHash: string; refreshError?: string };
    expect(directory.contentHash).toBe(connectCatalogContentHashV1([TOOL]));
    expect(directory.refreshError).toContain("exceeds its limit");
  });
});
