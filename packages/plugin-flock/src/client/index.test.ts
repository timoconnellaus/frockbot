import { afterEach, describe, expect, test } from "bun:test";
import type { ClientPluginContext } from "@frockbot/client-core";
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import { ref, type Ref } from "vue";
import { randomSheepRecipeV1 } from "../shared.js";
import { flockClientPlugin } from "./index.js";
import { pendingCreateKey, pendingSheepKey } from "./pending-create.js";
import type { FlockWebData } from "./state.js";

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

afterEach(() => {
  if (originalStorage)
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function mount(
  hostedRequest: NonNullable<ClientPluginContext["transport"]["hostedRequest"]>,
): Ref<FlockWebData> {
  let provided: Ref<FlockWebData> | undefined;
  flockClientPlugin({
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      readAuthenticatedUserId: () => Promise.resolve("user-a"),
      hostedRequest,
    },
    slot: () => () => undefined,
    inject: () => {
      throw new Error("unexpected client provider injection");
    },
    provide: (_key, value) => {
      provided = value as Ref<FlockWebData>;
      return () => undefined;
    },
  });
  if (!provided) throw new Error("Flock state was not provided");
  return provided;
}

describe("Flock client reconciliation", () => {
  test("latest click wins when identity responses resolve out of order", async () => {
    installStorage();
    const resolvers = new Map<string, (value: unknown) => void>();
    const state = mount(
      (path) => new Promise((resolve) => resolvers.set(path, resolve)),
    );
    const selected: string[] = [];
    state.value.bindShell(
      ref({
        selectBot: (botId: string) => {
          selected.push(botId);
          return Promise.resolve();
        },
      }) as unknown as Ref<FrockBotWebData>,
    );
    state.value.directory = {
      schemaVersion: 1,
      revision: 2,
      bots: [
        {
          schemaVersion: 1,
          botId: "old",
          registeredAt: new Date(0).toISOString(),
          initialName: "Old",
          sheep: randomSheepRecipeV1(() => 0),
        },
        {
          schemaVersion: 1,
          botId: "new",
          registeredAt: new Date(0).toISOString(),
          initialName: "New",
          sheep: randomSheepRecipeV1(() => 0),
        },
      ],
    };
    const oldSelection = state.value.select("old");
    const newSelection = state.value.select("new");
    resolvers.get("/api/bots/new/sheep")?.({
      schemaVersion: 1,
      botId: "new",
      revision: 0,
      sheep: randomSheepRecipeV1(() => 0),
    });
    await newSelection;
    resolvers.get("/api/bots/old/sheep")?.({
      schemaVersion: 1,
      botId: "old",
      revision: 0,
      sheep: randomSheepRecipeV1(() => 0),
    });
    await oldSelection;
    expect(selected).toEqual(["new"]);
  });

  test("opens creation without selecting or writing for an unknown query Bot", async () => {
    installStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=missing" } },
    });
    const sheep = randomSheepRecipeV1(() => 0);
    const methods: Array<string | undefined> = [];
    const state = mount((path, method) => {
      methods.push(method);
      if (path === "/api/bots")
        return Promise.resolve({
          schemaVersion: 1,
          revision: 1,
          bots: [
            {
              schemaVersion: 1,
              botId: "alpha",
              registeredAt: new Date(0).toISOString(),
              initialName: "Alpha",
              sheep,
            },
          ],
        });
      if (path === "/api/bots/alpha/sheep")
        return Promise.resolve({
          schemaVersion: 1,
          botId: "alpha",
          revision: 0,
          sheep,
        });
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    const selected: string[] = [];
    state.value.bindShell(
      ref({
        selectBot: (botId: string) => {
          selected.push(botId);
          return Promise.resolve();
        },
      }) as unknown as Ref<FrockBotWebData>,
    );

    await state.value.load();

    expect(state.value.overlay).toBe("create");
    expect(selected).toEqual([]);
    expect(methods).not.toContain("POST");
  });

  test("reconciles a pending update before accepting a new sheep draft", async () => {
    const storage = installStorage();
    const original = randomSheepRecipeV1(() => 0);
    const pendingSheep = randomSheepRecipeV1(() => 0.5);
    const finalSheep = randomSheepRecipeV1(() => 0.999);
    storage.set(
      pendingSheepKey("user-a", "alpha"),
      JSON.stringify({
        schemaVersion: 1,
        type: "bot/update-sheep",
        commandId: "pending-1",
        expectedRevision: 0,
        botId: "alpha",
        sheep: pendingSheep,
      }),
    );
    const posted: Array<Record<string, unknown>> = [];
    let revision = 1;
    const state = mount((path, method, body) => {
      if (method === "POST") {
        const command = JSON.parse(body ?? "") as Record<string, unknown>;
        posted.push(command);
        return Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: posted.length,
        });
      }
      if (path === "/api/bots/alpha/sheep")
        return Promise.resolve({
          schemaVersion: 1,
          botId: "alpha",
          revision: revision++,
          sheep: posted.length === 1 ? pendingSheep : finalSheep,
        });
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    state.value.bindShell(
      ref({ activeBotId: "alpha" }) as unknown as Ref<FrockBotWebData>,
    );
    state.value.identities.alpha = {
      schemaVersion: 1,
      botId: "alpha",
      revision: 0,
      sheep: original,
    };

    await state.value.openEdit();
    expect(state.value.draftSheep).toEqual(pendingSheep);
    state.value.draftSheep = finalSheep;
    await state.value.saveSheep();

    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      commandId: "pending-1",
      sheep: pendingSheep,
    });
    expect(posted[1]).toMatchObject({ expectedRevision: 1, sheep: finalSheep });
    expect(storage.has(pendingSheepKey("user-a", "alpha"))).toBe(false);
    expect(state.value.identities.alpha?.sheep).toEqual(finalSheep);
  });

  test("surfaces definitive pending creation failures", async () => {
    const storage = installStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/" } },
    });
    storage.set(
      pendingCreateKey("user-a"),
      JSON.stringify({
        schemaVersion: 1,
        type: "bot/create",
        commandId: "pending-create",
        expectedRevision: 0,
        botId: "alpha",
        name: "Alpha",
      }),
    );
    const definitive = Object.assign(new Error("Directory changed"), {
      definitive: true,
    });
    const state = mount((path, method) => {
      if (path === "/api/bots" && method === "POST")
        return Promise.reject(definitive);
      if (path === "/api/bots")
        return Promise.resolve({ schemaVersion: 1, revision: 1, bots: [] });
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });

    await state.value.load();

    expect(state.value.error).toBe("Directory changed");
    expect(storage.has(pendingCreateKey("user-a"))).toBe(false);
  });

  test("selects a newly created Bot from an unknown onboarding URL", async () => {
    installStorage();
    const location = { href: "https://app.example/?bot=missing" };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location,
        history: {
          state: null,
          replaceState: (_state: unknown, _title: string, url: URL) => {
            location.href = url.href;
          },
        },
      },
    });
    const sheep = randomSheepRecipeV1(() => 0);
    let created: Record<string, unknown> | undefined;
    const state = mount((path, method, body) => {
      if (path === "/api/bots" && method === "POST") {
        created = JSON.parse(body ?? "") as Record<string, unknown>;
        return Promise.resolve({
          schemaVersion: 1,
          commandId: created.commandId,
          status: "applied",
          revision: 1,
        });
      }
      if (path === "/api/bots")
        return Promise.resolve({
          schemaVersion: 1,
          revision: 1,
          bots: created
            ? [
                {
                  schemaVersion: 1,
                  botId: created.botId,
                  registeredAt: new Date(0).toISOString(),
                  initialName: created.name,
                  sheep,
                },
              ]
            : [],
        });
      if (created && path === `/api/bots/${created.botId as string}/sheep`)
        return Promise.resolve({
          schemaVersion: 1,
          botId: created.botId,
          revision: 0,
          sheep,
        });
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    const selected: string[] = [];
    state.value.bindShell(
      ref({
        selectBot: (botId: string) => {
          selected.push(botId);
          return Promise.resolve();
        },
      }) as unknown as Ref<FrockBotWebData>,
    );
    state.value.directory = { schemaVersion: 1, revision: 0, bots: [] };
    state.value.draftName = "Alpha";
    state.value.draftSheep = sheep;
    state.value.overlay = "create";

    await state.value.create();

    const createdBotId = created?.botId;
    if (typeof createdBotId !== "string")
      throw new Error("Create command was not sent");
    expect(new URL(location.href).searchParams.get("bot")).toBe(createdBotId);
    expect(state.value.overlay).toBeUndefined();
    expect(selected).not.toHaveLength(0);
    expect(selected.every((botId) => botId === createdBotId)).toBe(true);
  });

  test("reconciles a lost sheep response and clears the exact pending command", async () => {
    const storage = installStorage();
    const original = randomSheepRecipeV1(() => 0);
    const updated = randomSheepRecipeV1(() => 0.999);
    const state = mount((path, method) => {
      if (method === "POST") return Promise.reject(new Error("response lost"));
      if (path === "/api/bots/alpha/sheep")
        return Promise.resolve({
          schemaVersion: 1,
          botId: "alpha",
          revision: 1,
          sheep: updated,
        });
      return Promise.reject(new Error(`unexpected request: ${path}`));
    });
    state.value.bindShell(
      ref({ activeBotId: "alpha" }) as unknown as Ref<FrockBotWebData>,
    );
    state.value.identities.alpha = {
      schemaVersion: 1,
      botId: "alpha",
      revision: 0,
      sheep: original,
    };
    state.value.draftSheep = updated;
    state.value.overlay = "edit";
    await state.value.saveSheep();
    expect(state.value.identities.alpha?.sheep).toEqual(updated);
    expect(state.value.overlay).toBeUndefined();
    expect(storage.has(pendingSheepKey("user-a", "alpha"))).toBe(false);
  });
});
