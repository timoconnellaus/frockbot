// Registering a machine, as the product does it end to end.
//
// The app half is a session: `POST /api/machines/enroll` through the
// gateway's authenticated door, answered with the machine's token for the app
// to hand its agent. The machine half is not a session at all — the stub
// device agent opens its socket through `SELF.fetch` with that bearer token
// and nothing else, over the gateway's pre-authentication `publicRoute` seam.
//
// `MachineAgentDriverV1` is the whole device agent minus `child_process`: it
// speaks the real protocol, decodes every answer with the shipped decoders,
// and is the same driver the desktop agent's own handlers will be checked
// against.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  decodeMachineEnrollmentReceiptV1,
  machineRoutePathV1,
} from "@frockbot/core/machine-protocol";
import { MachineAgentDriverV1 } from "@frockbot/app/machine/testing";
import { fetchUpgradeMachineWebSocketV1 } from "@frockbot/app/machine/device";
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
    webSocket: fetchUpgradeMachineWebSocketV1((input, init) =>
      SELF.fetch(input, init),
    ),
    label,
    platform: "macos",
    agentVersion: "0.4.1",
    capabilities: ["exec", "files"],
  });
}

/** The signed-in app enrolling `device`, and handing it the token. */
async function enroll(
  userId: string,
  device: MachineAgentDriverV1,
  machineId?: string,
): Promise<string> {
  return device.adopt(
    decodeMachineEnrollmentReceiptV1(
      await expectOkJson(
        await postAsUser(
          userId,
          machineRoutePathV1("enroll"),
          device.enrollment(machineId),
        ),
      ),
    ),
  );
}

/** A socket close reaches the User Durable Object asynchronously. */
async function eventually(
  userId: string,
  connected: boolean,
): Promise<MachineListProbe> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const listed = (await expectOkJson(
      await asUser(userId, machineRoutePathV1("list")),
    )) as MachineListProbe;
    if (listed.machines[0]?.connected === connected) return listed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the machine never read connected: ${connected}`);
}

describe("registering a machine", () => {
  it("enrols from a session, connects anonymously, reports presence, and dies on revocation", async () => {
    const userId = freshUserId("machines");

    // 1-2. The signed-in app enrolls its agent and hands it the token. From
    //      here the machine speaks with no session, no cookie, no user header.
    const device = agent("Tims-M5-MacBook-Pro.local");
    const token = await enroll(userId, device);
    const offer = { machineId: device.machineId! };

    // 3. The registry is the `ListMachines` projection. Registered is not
    //    connected: presence is an open socket.
    const listed = (await expectOkJson(
      await asUser(userId, machineRoutePathV1("list")),
    )) as MachineListProbe;
    expect(listed.machines).toMatchObject([
      {
        machineId: offer.machineId,
        label: "Tims-M5-MacBook-Pro.local",
        connected: false,
        platform: "macos",
        capabilities: ["exec", "files"],
      },
    ]);

    // 4. Opening the socket is connecting, and it is sent the empty queue;
    //    closing it is going offline, with nothing to clean up.
    expect(await device.next()).toEqual([]);
    await eventually(userId, true);
    device.disconnect();
    await eventually(userId, false);
    // …and reconnecting brings it back.
    expect(await device.next()).toEqual([]);
    await eventually(userId, true);

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
    // The socket the machine held is closed as revoked.
    await expect(device.next()).rejects.toMatchObject({ status: 4001 });

    expect(
      await device.attempt(
        machineRoutePathV1("socket", { machineId: offer.machineId }),
        { token, headers: { upgrade: "websocket" } },
      ),
    ).toBe(401);
    for (const [path, method] of [
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

  it("answers a retried enrollment with the same machine, and never enrols without a session", async () => {
    const userId = freshUserId("machines-retry");
    const first = await enroll(userId, agent("First.local"), "mac-retried");
    const second = await enroll(userId, agent("First.local"), "mac-retried");
    expect(second).toBe(first);
    expect(
      (
        (await expectOkJson(
          await asUser(userId, machineRoutePathV1("list")),
        )) as MachineListProbe
      ).machines,
    ).toHaveLength(1);
    // A program with no session cannot register a machine at all.
    const anonymous = await SELF.fetch(
      `${ORIGIN}${machineRoutePathV1("enroll")}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-a-session",
          "content-type": "application/json",
        },
        body: JSON.stringify(agent("Forged.local").enrollment()),
      },
    );
    expect(anonymous.status).toBe(401);
  });

  it("keeps one User's machines out of another's registry", async () => {
    const mine = freshUserId("machines-mine");
    const theirs = freshUserId("machines-theirs");
    const device = agent("Mine.local");
    await enroll(mine, device);
    const offer = { machineId: device.machineId! };
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
