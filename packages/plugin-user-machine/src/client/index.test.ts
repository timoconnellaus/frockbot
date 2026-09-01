// The Computer settings section's store, driven without a DOM.
//
// The house pattern: build a `ClientPluginContext` by hand, run the plugin,
// take the state ref it provided and the slots it mounted, and drive the store
// against a recorded transport. What is proved here is what the section
// promises — every read decoded at the seam, every refusal surfaced verbatim,
// and the desktop half absent when there is no desktop.

import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { MACHINE_SURFACE_ID_V1, userMachineClientPlugin } from "./index.js";
import { machinesStateKey, type MachinesClientState } from "./state.js";

const MACHINE = {
  machineId: "m-1",
  label: "Tims-M5-MacBook-Pro.local",
  platform: "macos",
  capabilities: ["exec", "files"],
  connected: true,
  lastSeenAt: "2026-09-01T00:00:00.000Z",
  registeredAt: "2026-08-31T00:00:00.000Z",
};

const LIST = {
  schemaVersion: 1,
  machines: [MACHINE],
  serverTime: "2026-09-01T00:00:10.000Z",
};

const OFFER = {
  schemaVersion: 1,
  code: "pairing-code",
  machineId: "m-2",
  expiresAt: "2026-09-01T00:05:00.000Z",
};

const AGENT_STATUS = {
  schemaVersion: 1,
  enrolled: true,
  running: true,
  machineId: "m-1",
  label: "Tims-M5-MacBook-Pro.local",
  origin: "https://bot.example.com",
  failures: 0,
};

interface Bridge {
  status(): Promise<unknown>;
  pair(code: string): Promise<unknown>;
  unpair(): Promise<unknown>;
}

function mount(
  overrides: {
    hostedRequest?: ClientPluginContext["transport"]["hostedRequest"];
    bridge?: Bridge;
  } = {},
): {
  state: { value: MachinesClientState };
  slots: ClientSlotRegistration[];
  calls: Array<[string, string | undefined, string | undefined]>;
  surfaces: ReturnType<typeof createClientSurfaceRegistry>;
  dispose(): void;
} {
  const slots: ClientSlotRegistration[] = [];
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  const surfaces = createClientSurfaceRegistry();
  let state: unknown;
  const globals = globalThis as { frockbotMachineAgent?: Bridge };
  if (overrides.bridge) globals.frockbotMachineAgent = overrides.bridge;
  else delete globals.frockbotMachineAgent;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest:
        overrides.hostedRequest ??
        ((path, method, body) => {
          calls.push([path, method, body]);
          if (path === "/api/machines/pair") return Promise.resolve(OFFER);
          if (path.endsWith("/revoke")) {
            return Promise.resolve({
              ...LIST,
              machines: [
                { ...MACHINE, connected: false, revokedAt: LIST.serverTime },
              ],
            });
          }
          return Promise.resolve(LIST);
        }),
    },
    inject: (key) => {
      if (key !== clientSurfaceRegistryKey) {
        throw new Error("unexpected client provider");
      }
      return surfaces as never;
    },
    provide: (key, value) => {
      if (key === machinesStateKey) state = value;
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration);
      return () => slots.splice(slots.indexOf(registration), 1);
    },
  };
  const disposers = userMachineClientPlugin(context);
  if (!Array.isArray(disposers)) throw new Error("expected registrations");
  return {
    state: state as { value: MachinesClientState },
    slots,
    calls,
    surfaces,
    dispose: () => {
      delete globals.frockbotMachineAgent;
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

describe("registered machines client contribution", () => {
  test("mounts one settings section and one surface", () => {
    const mounted = mount();
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.user-settings-sections",
    ]);
    expect(mounted.surfaces.has(MACHINE_SURFACE_ID_V1)).toBe(true);
    mounted.dispose();
    expect(mounted.surfaces.has(MACHINE_SURFACE_ID_V1)).toBe(false);
  });

  test("loads the registry and decodes it at the seam", async () => {
    const mounted = mount();
    await mounted.state.value.load();
    expect(mounted.calls[0]).toEqual(["/api/machines", undefined, undefined]);
    expect(mounted.state.value.view?.machines[0]).toMatchObject({
      machineId: "m-1",
      connected: true,
    });
    // Presence came from the backend; nothing here recomputed it.
    expect(mounted.state.value.desktop).toBe(false);
    mounted.dispose();
  });

  test("a browser can mint a code but cannot pair itself", async () => {
    const mounted = mount();
    await mounted.state.value.requestCode("Tims-M5-MacBook-Pro.local");
    expect(mounted.calls[0]).toEqual([
      "/api/machines/pair",
      "POST",
      JSON.stringify({ label: "Tims-M5-MacBook-Pro.local" }),
    ]);
    expect(mounted.state.value.offer?.code).toBe("pairing-code");

    await mounted.state.value.pairThisComputer();
    expect(mounted.state.value.error).toBe(
      "This client is not the desktop app",
    );
    mounted.dispose();
  });

  test("the desktop shell mints a code and hands it to its own agent", async () => {
    const handed: string[] = [];
    const mounted = mount({
      bridge: {
        status: () => Promise.resolve(AGENT_STATUS),
        pair: (code) => {
          handed.push(code);
          return Promise.resolve(AGENT_STATUS);
        },
        unpair: () =>
          Promise.resolve({
            schemaVersion: 1,
            enrolled: false,
            running: false,
            failures: 0,
          }),
      },
    });

    expect(mounted.state.value.desktop).toBe(true);
    await mounted.state.value.pairThisComputer();

    expect(handed).toEqual(["pairing-code"]);
    expect(mounted.state.value.agent?.enrolled).toBe(true);
    // The code is one-time: once spent it is not left on screen.
    expect(mounted.state.value.offer).toBeUndefined();
    expect(mounted.calls.map(([path]) => path)).toEqual([
      "/api/machines/pair",
      "/api/machines",
    ]);

    await mounted.state.value.forgetThisComputer();
    expect(mounted.state.value.agent?.enrolled).toBe(false);
    mounted.dispose();
  });

  test("a code typed by hand reaches the agent as it was typed", async () => {
    const handed: string[] = [];
    const mounted = mount({
      bridge: {
        status: () => Promise.resolve(AGENT_STATUS),
        pair: (code) => {
          handed.push(code);
          return Promise.resolve(AGENT_STATUS);
        },
        unpair: () => Promise.resolve(AGENT_STATUS),
      },
    });
    await mounted.state.value.enterCode("  typed-code  ");
    expect(handed).toEqual(["typed-code"]);
    mounted.dispose();
  });

  test("revoking takes the registry back from the authority", async () => {
    const mounted = mount();
    await mounted.state.value.revoke("m-1");
    expect(mounted.calls[0]).toEqual([
      "/api/machines/m-1/revoke",
      "POST",
      "{}",
    ]);
    expect(mounted.state.value.view?.machines[0]?.revokedAt).toBeDefined();
    expect(mounted.state.value.view?.machines[0]?.connected).toBe(false);
    mounted.dispose();
  });

  test("a refusal is surfaced rather than swallowed", async () => {
    const mounted = mount({
      hostedRequest: () =>
        Promise.reject(new Error("machine registration is not configured")),
    });
    await mounted.state.value.load();
    expect(mounted.state.value.error).toBe(
      "machine registration is not configured",
    );
    expect(mounted.state.value.busy).toBe(false);
    mounted.dispose();
  });
});
