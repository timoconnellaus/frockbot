// Registering a machine the way a person does: from the settings section.
//
// The two halves of the product are both real here. The **section's store** is
// the shipped `userMachineClientPlugin`, driven over `hostedRequest` — which
// is the deployment, through `SELF.fetch`, under a session. The **agent** is
// the shipped `MachineDeviceAgentV1`, behind the same three-verb bridge the
// Electron preload exposes, with only `child_process` faked.
//
// So "pair this computer" here does what it does on a laptop: the browser half
// asks the backend for a one-time code with the user's session, hands it
// across the bridge, and the agent enrols with no session at all. Nothing in
// this file constructs a token, and nothing reads one.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { MACHINE_LIMITS_V1 } from "@frockbot/machine-protocol";
import { userMachineClientPlugin } from "@frockbot/plugin-user-machine/client";
import {
  machinesStateKey,
  type MachinesClientState,
} from "@frockbot/plugin-user-machine/client/state";
import {
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
} from "@frockbot/plugin-user-machine/device";
import { createMachineDeviceRunnerV1 } from "@frockbot/plugin-user-machine/device-runner";
import {
  asUser,
  freshUserId,
  ORIGIN,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface Bridge {
  status(): Promise<unknown>;
  pair(code: string): Promise<unknown>;
  unpair(): Promise<unknown>;
}

/** The device agent, as the desktop shell builds it, with a faked laptop. */
function deviceAgent(): {
  agent: MachineDeviceAgentV1;
  bridge: Bridge;
  ran: string[];
} {
  const ran: string[] = [];
  const agent = new MachineDeviceAgentV1({
    origin: ORIGIN,
    // No session header: the machine's four routes are the pre-authentication
    // seam, and an agent that needed a cookie would be a different design.
    fetch: (input, init) => SELF.fetch(input, init),
    secrets: createMemoryMachineSecretStoreV1(),
    runner: createMachineDeviceRunnerV1({
      host: {
        identity: () => ({
          label: "Tims-M5-MacBook-Pro.local",
          platform: "macos",
        }),
        exec: (request) => {
          ran.push(request.command);
          return Promise.resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
          });
        },
        readFile: () => Promise.resolve({ bytesBase64: "", truncated: false }),
      },
      capabilities: ["exec", "files"],
    }),
    label: "Tims-M5-MacBook-Pro.local",
    platform: "macos",
    agentVersion: "0.0.1",
    capabilities: ["exec", "files"],
  });
  return {
    agent,
    ran,
    bridge: {
      status: () => Promise.resolve(agent.status()),
      pair: (code) => agent.pair(code),
      unpair: () => agent.unpair(),
    },
  };
}

/** The settings section's store, over the deployment's own routes. */
function section(
  userId: string,
  bridge?: Bridge,
): {
  state: { value: MachinesClientState };
  slots: ClientSlotRegistration[];
  dispose(): void;
} {
  const slots: ClientSlotRegistration[] = [];
  // A surface registry, minimally: the section registers its own surface and
  // this test never opens one, so the real registry's reactivity is not what
  // is under test here.
  const registered = new Set<string>();
  const surfaces = {
    register: (registration: { id: string }) => {
      registered.add(registration.id);
      return () => registered.delete(registration.id);
    },
  };
  const globals = globalThis as { frockbotMachineAgent?: Bridge };
  if (bridge) globals.frockbotMachineAgent = bridge;
  else delete globals.frockbotMachineAgent;
  let state: unknown;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest: async (path, method = "GET", body) => {
        const response = await asUser(userId, path, {
          method,
          ...(body === undefined ? {} : { body }),
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          throw new Error(
            typeof value === "object" &&
              value !== null &&
              "error" in value &&
              typeof value.error === "string"
              ? value.error
              : "Hosted request failed",
          );
        }
        return value;
      },
    },
    inject: (key) => {
      if (key !== clientSurfaceRegistryKey)
        throw new Error("unexpected inject");
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
    dispose: () => {
      delete globals.frockbotMachineAgent;
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

/** Age the machine's presence past its TTL, without touching anything else. */
async function stopPolling(userId: string, machineId: string): Promise<void> {
  await runInDurableObject(
    env.USER_CONFIGURATIONS.getByName(userId),
    async (_instance, state) => {
      const key = `machine:${machineId}`;
      const record = await state.storage.get<{ lastSeenAt: string }>(key);
      expect(record).toBeDefined();
      await state.storage.put(key, {
        ...record!,
        lastSeenAt: new Date(
          Date.now() - MACHINE_LIMITS_V1.presenceTtlMs - 1_000,
        ).toISOString(),
      });
    },
  );
}

describe("the Computer settings section", () => {
  it("pairs this computer, reads it connected, and revokes it", async () => {
    const userId = freshUserId("machines-settings");
    const device = deviceAgent();
    const surface = section(userId, device.bridge);
    try {
      // The section mounts where the plan says, and knows it is the desktop.
      expect(surface.slots.map((slot) => slot.slot)).toEqual([
        "frockbot.user-settings-sections",
      ]);
      expect(surface.state.value.desktop).toBe(true);

      await surface.state.value.load();
      expect(surface.state.value.view?.machines).toEqual([]);

      // One click. The code is minted under the session and spent by the agent.
      await surface.state.value.pairThisComputer();
      expect(surface.state.value.error).toBeUndefined();
      expect(surface.state.value.agent?.enrolled).toBe(true);
      // The one-time code is not left on screen once it has been spent.
      expect(surface.state.value.offer).toBeUndefined();

      const machineId = surface.state.value.agent?.machineId;
      expect(machineId).toBeDefined();
      expect(surface.state.value.view?.machines).toMatchObject([
        {
          machineId,
          label: "Tims-M5-MacBook-Pro.local",
          platform: "macos",
          capabilities: ["exec", "files"],
          connected: true,
        },
      ]);

      // Presence is arithmetic: a laptop that stops polling reads offline in
      // the section, and one that polls again reads connected.
      await stopPolling(userId, machineId!);
      await surface.state.value.load();
      expect(surface.state.value.view?.machines).toMatchObject([
        { connected: false },
      ]);
      expect(await device.agent.runOnce(0)).toMatchObject({
        paired: true,
        delivered: 0,
      });
      await surface.state.value.load();
      expect(surface.state.value.view?.machines).toMatchObject([
        { connected: true },
      ]);

      // Revoking from the section kills the token wherever the laptop is.
      await surface.state.value.revoke(machineId!);
      expect(surface.state.value.view?.machines[0]?.revokedAt).toBeDefined();
      expect(surface.state.value.view?.machines[0]?.connected).toBe(false);

      // The agent finds out the only way it can: its next poll is refused, and
      // it forgets the token rather than retrying a door that will not open.
      const cycle = await device.agent.runOnce(0);
      expect(cycle.unenrolled).toBe(true);
      expect(device.agent.status().enrolled).toBe(false);
      // Nothing ever ran on the laptop: no command was ever approved.
      expect(device.ran).toEqual([]);
    } finally {
      surface.dispose();
    }
  });

  it("in a browser, mints a code to type into the desktop app instead", async () => {
    const userId = freshUserId("machines-browser");
    const surface = section(userId);
    try {
      expect(surface.state.value.desktop).toBe(false);

      await surface.state.value.requestCode("Tims-M5-MacBook-Pro.local");
      const offer = surface.state.value.offer;
      expect(offer?.code).toBeDefined();
      expect(Date.parse(offer!.expiresAt) - Date.now()).toBeLessThanOrEqual(
        MACHINE_LIMITS_V1.pairingTtlMs,
      );

      // A browser cannot pair itself, and says so rather than pretending.
      await surface.state.value.pairThisComputer();
      expect(surface.state.value.error).toBe(
        "This client is not the desktop app",
      );

      // The code is spendable by a machine, which is the point of showing it.
      const device = deviceAgent();
      await device.agent.pair(offer!.code);
      await surface.state.value.load();
      expect(surface.state.value.view?.machines).toMatchObject([
        { machineId: offer!.machineId, connected: true },
      ]);
    } finally {
      surface.dispose();
    }
  });
});
