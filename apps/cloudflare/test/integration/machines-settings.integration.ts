// Registering a machine the way a person does: from the Machines surface.
//
// The two halves of the product are both real here. The **surface's** half is
// the three session routes the Flutter page calls — `POST /api/machines/pair`,
// `GET /api/machines`, `POST /api/machines/:id/revoke` — driven through
// `SELF.fetch` under a session. The **agent** is the shipped
// `MachineDeviceAgentV1`, with only `child_process` faked.
//
// So "pair this computer" here does what it does on a laptop: the surface asks
// the backend for a one-time code with the user's session, the person carries
// it to the machine, and the agent enrols with no session at all. Nothing in
// this file constructs a token, and nothing reads one.

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MACHINE_LIMITS_V1 } from "@frockbot/core/machine-protocol";
import {
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
} from "@frockbot/app/machine/device";
import { createMachineDeviceRunnerV1 } from "@frockbot/app/machine/device-runner";
import {
  asUser,
  freshUserId,
  ORIGIN,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** The device agent, as the machine runs it, with a faked laptop. */
function deviceAgent(): { agent: MachineDeviceAgentV1; ran: string[] } {
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
  return { agent, ran };
}

interface MachineRowV1 {
  machineId: string;
  label: string;
  platform: string;
  capabilities: string[];
  connected: boolean;
  revokedAt?: string;
}

async function listMachines(userId: string): Promise<MachineRowV1[]> {
  const response = await asUser(userId, "/api/machines");
  expect(response.status).toBe(200);
  const view = (await response.json()) as { machines: MachineRowV1[] };
  return view.machines;
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

describe("the Machines surface", () => {
  it("mints a code, reads the machine connected, and revokes it", async () => {
    const userId = freshUserId("machines-settings");
    expect(await listMachines(userId)).toEqual([]);

    // The code is minted under the session and spent by the agent, which holds
    // no session of its own.
    const offerResponse = await postAsUser(userId, "/api/machines/pair", {
      label: "Tims-M5-MacBook-Pro.local",
    });
    expect(offerResponse.status).toBe(200);
    const offer = (await offerResponse.json()) as {
      code: string;
      machineId: string;
      expiresAt: string;
    };
    expect(Date.parse(offer.expiresAt) - Date.now()).toBeLessThanOrEqual(
      MACHINE_LIMITS_V1.pairingTtlMs,
    );

    const device = deviceAgent();
    await device.agent.pair(offer.code);
    expect(device.agent.status().enrolled).toBe(true);

    expect(await listMachines(userId)).toMatchObject([
      {
        machineId: offer.machineId,
        label: "Tims-M5-MacBook-Pro.local",
        platform: "macos",
        capabilities: ["exec", "files"],
        connected: true,
      },
    ]);

    // Presence is arithmetic: a laptop that stops polling reads offline, and
    // one that polls again reads connected.
    await stopPolling(userId, offer.machineId);
    expect(await listMachines(userId)).toMatchObject([{ connected: false }]);
    expect(await device.agent.runOnce(0)).toMatchObject({
      paired: true,
      delivered: 0,
    });
    expect(await listMachines(userId)).toMatchObject([{ connected: true }]);

    // Revoking from the surface kills the token wherever the laptop is.
    const revoked = await postAsUser(
      userId,
      `/api/machines/${encodeURIComponent(offer.machineId)}/revoke`,
      {},
    );
    expect(revoked.status).toBe(200);
    const after = await listMachines(userId);
    expect(after[0]?.revokedAt).toBeDefined();
    expect(after[0]?.connected).toBe(false);

    // The agent finds out the only way it can: its next poll is refused, and
    // it forgets the token rather than retrying a door that will not open.
    const cycle = await device.agent.runOnce(0);
    expect(cycle.unenrolled).toBe(true);
    expect(device.agent.status().enrolled).toBe(false);
    // Nothing ever ran on the laptop: no command was ever approved.
    expect(device.ran).toEqual([]);
  });

  it("refuses a code that was already spent", async () => {
    const userId = freshUserId("machines-replay");
    const offerResponse = await postAsUser(userId, "/api/machines/pair", {
      label: "Tims-M5-MacBook-Pro.local",
    });
    const offer = (await offerResponse.json()) as { code: string };

    await deviceAgent().agent.pair(offer.code);
    await expect(deviceAgent().agent.pair(offer.code)).rejects.toThrow();
    expect(await listMachines(userId)).toHaveLength(1);
  });
});
