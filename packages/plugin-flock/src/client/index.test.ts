import { afterEach, describe, expect, test } from "bun:test";
import type { ClientPluginContext } from "@frockbot/client-core";
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import { ref, type Ref } from "vue";
import { randomSheepRecipeV1 } from "../shared.js";
import { flockClientPlugin } from "./index.js";
import { pendingSheepKey } from "./pending-create.js";
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
          botId: "old",
          registeredAt: new Date(0).toISOString(),
          initialName: "Old",
          sheep: randomSheepRecipeV1(() => 0),
        },
        {
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
