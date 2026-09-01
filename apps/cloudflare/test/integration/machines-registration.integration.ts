// Registering a machine, as the product does it end to end.
//
// The browser half is a session: `POST /api/machines/pair` through the
// gateway's authenticated door. The machine half is not a session at all — the
// stub device agent enrols and polls through `SELF.fetch` with a bearer token
// and nothing else, over the gateway's pre-authentication `publicRoute` seam.
//
// `MachineAgentDriverV1` is the whole device agent minus `child_process`: it
// speaks the real protocol, decodes every answer with the shipped decoders,
// and is the same driver the desktop agent's own handlers will be checked
// against.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MACHINE_LIMITS_V1,
  machineRoutePathV1,
} from "@frockbot/machine-protocol";
import { MachineAgentDriverV1 } from "@frockbot/plugin-user-machine/testing";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface MachineListProbe {
  machines: Array<{
    machineId: string;
    label: string;
    connected: boolean;
    platform: string;
    capabilities: string[];
    revokedAt?: string;
  }>;
}

/** A device agent as it really reaches the deployment: anonymous, over HTTP. */
function agent(label: string): MachineAgentDriverV1 {
  return new MachineAgentDriverV1({
    origin: ORIGIN,
    fetch: (input, init) => SELF.fetch(input, init),
    label,
    platform: "macos",
    agentVersion: "0.4.1",
    capabilities: ["exec", "files"],
  });
}

/**
 * Age the machine's presence past its TTL.
 *
 * `connected` is arithmetic over `lastSeenAt` and the TTL is ninety seconds,
 * so the honest way to prove "a laptop that stops polling goes offline on its
 * own" without sleeping is to move the stored timestamp back. Nothing else in
 * the record is touched, and the answer still comes from the product's own
 * projection.
 */
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

describe("registering a machine", () => {
  it("pairs from a session, enrols anonymously, reports presence, and dies on revocation", async () => {
    const userId = freshUserId("machines");

    // 1. The browser asks for a code. It is the only secret a browser holds
    //    for a machine, and it is one-time and five minutes old at most.
    const offer = (await expectOkJson(
      await postAsUser(userId, machineRoutePathV1("pair"), {
        label: "Tims-M5-MacBook-Pro.local",
      }),
    )) as { code: string; machineId: string; expiresAt: string };
    expect(Date.parse(offer.expiresAt) - Date.now()).toBeLessThanOrEqual(
      MACHINE_LIMITS_V1.pairingTtlMs,
    );

    // 2. The machine enrols with it — no session, no cookie, no user header.
    const device = agent("Tims-M5-MacBook-Pro.local");
    const token = await device.enroll(offer.code);
    expect(device.machineId).toBe(offer.machineId);

    // 3. The registry is the `ListMachines` projection, and it says connected
    //    because the machine has just been seen.
    const listed = (await expectOkJson(
      await asUser(userId, machineRoutePathV1("list")),
    )) as MachineListProbe;
    expect(listed.machines).toMatchObject([
      {
        machineId: offer.machineId,
        label: "Tims-M5-MacBook-Pro.local",
        connected: true,
        platform: "macos",
        capabilities: ["exec", "files"],
      },
    ]);

    // 4. A poll refreshes presence; a machine that stops polling goes offline
    //    with nothing to clean up.
    expect(await device.poll()).toEqual([]);
    await stopPolling(userId, offer.machineId);
    const offline = (await expectOkJson(
      await asUser(userId, machineRoutePathV1("list")),
    )) as MachineListProbe;
    expect(offline.machines).toMatchObject([{ connected: false }]);
    // …and polling again brings it back, because presence is nothing but the
    // last time this machine spoke.
    await device.poll();
    const back = (await expectOkJson(
      await asUser(userId, machineRoutePathV1("list")),
    )) as MachineListProbe;
    expect(back.machines).toMatchObject([{ connected: true }]);

    // 5. Revocation bumps the key version, so the token the machine holds is
    //    dead at the very next call — at every machine route.
    const revoked = (await expectOkJson(
      await postAsUser(
        userId,
        machineRoutePathV1("revoke", { machineId: offer.machineId }),
        {},
      ),
    )) as MachineListProbe;
    expect(revoked.machines[0]).toMatchObject({ connected: false });
    expect(revoked.machines[0]?.revokedAt).toBeDefined();

    for (const [path, method] of [
      [machineRoutePathV1("poll", { machineId: offer.machineId }), "GET"],
      [
        machineRoutePathV1("claim", {
          machineId: offer.machineId,
          commandId: "tool:1:1:0",
        }),
        "POST",
      ],
      [
        machineRoutePathV1("result", {
          machineId: offer.machineId,
          commandId: "tool:1:1:0",
        }),
        "POST",
      ],
    ] as const) {
      expect(
        await device.attempt(path, {
          token,
          method,
          ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
        }),
      ).toBe(401);
    }
  });

  it("refuses a code that was already spent, and one nobody minted", async () => {
    const userId = freshUserId("machines-code");
    const offer = (await expectOkJson(
      await postAsUser(userId, machineRoutePathV1("pair"), {}),
    )) as { code: string; machineId: string };
    await agent("First.local").enroll(offer.code);
    // The offer is spent, so the same code registers nothing a second time.
    await expect(agent("Second.local").enroll(offer.code)).rejects.toThrow(
      /401/,
    );
    // …and a code nobody signed never reaches a Durable Object at all.
    const forged = await SELF.fetch(
      `${ORIGIN}${machineRoutePathV1("enroll")}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-a-pairing-code",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          code: "not-a-pairing-code",
          label: "Forged.local",
          platform: "macos",
          agentVersion: "0.4.1",
          capabilities: ["exec"],
        }),
      },
    );
    expect(forged.status).toBe(401);
  });

  it("keeps one User's machines out of another's registry", async () => {
    const mine = freshUserId("machines-mine");
    const theirs = freshUserId("machines-theirs");
    const offer = (await expectOkJson(
      await postAsUser(mine, machineRoutePathV1("pair"), {}),
    )) as { code: string; machineId: string };
    await agent("Mine.local").enroll(offer.code);
    expect(
      (
        (await expectOkJson(
          await asUser(theirs, machineRoutePathV1("list")),
        )) as MachineListProbe
      ).machines,
    ).toEqual([]);
    // Revoking somebody else's machine is a 404, not a revocation: the User
    // Durable Object holds only its own registry, and it has never heard of it.
    const attempted = await postAsUser(
      theirs,
      machineRoutePathV1("revoke", { machineId: offer.machineId }),
      {},
    );
    expect(attempted.status).toBe(404);
    const untouched = (
      (await expectOkJson(
        await asUser(mine, machineRoutePathV1("list")),
      )) as MachineListProbe
    ).machines;
    expect(untouched).toMatchObject([{ machineId: offer.machineId }]);
    expect(untouched[0]?.revokedAt).toBeUndefined();
  });
});
