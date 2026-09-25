// A registered machine's socket, opened on the User Durable Object's own
// `fetch` exactly as the gateway forwards an upgrade whose token verified.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  decodeMachineSocketFrameV1,
  machineRoutePathV1,
  type MachineSocketFrameV1,
  type MachineTokenClaimsV1,
} from "@frockbot/core/machine-protocol";
import {
  machineSocketFromWebSocketV1,
  type MachineSocketV1,
} from "@frockbot/app/machine/device";
import { internalMachineSocketRequestV1 } from "../src/machine-socket.ts";

export interface EnrolledMachineV1 {
  machineId: string;
  claims: MachineTokenClaimsV1;
  /** `SHA-256(token)`: what the gateway forwards in place of the token. */
  digest: string;
}

/** The forwarded upgrade, answered by the object itself. */
export function upgradeMachineSocket(
  userId: string,
  machine: EnrolledMachineV1,
  headers: Record<string, string> = { upgrade: "websocket" },
): Promise<Response> {
  return env.USER_CONFIGURATIONS.getByName(userId).fetch(
    internalMachineSocketRequestV1(
      userId,
      {
        machineId: machine.machineId,
        claims: machine.claims,
        tokenDigest: machine.digest,
      },
      new Request(
        `https://bot.frockbot.com${machineRoutePathV1("socket", {
          machineId: machine.machineId,
        })}`,
        { headers },
      ),
    ),
  );
}

/** Open the machine's socket, or fail the test with the refusal. */
export async function openMachineSocket(
  userId: string,
  machine: EnrolledMachineV1,
): Promise<MachineSocketV1> {
  const response = await upgradeMachineSocket(userId, machine);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return machineSocketFromWebSocketV1(socket);
}

/**
 * The next frame of `type`, failing rather than hanging. Frames of the other
 * type are read past: a socket is sent its module list after every connect.
 */
export async function nextMachineFrameOf<
  T extends MachineSocketFrameV1["type"],
>(
  socket: MachineSocketV1,
  type: T,
): Promise<Extract<MachineSocketFrameV1, { type: T }>> {
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const event = await Promise.race([
      socket.receive(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("no frame within 5s")),
          5_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (event.type !== "message") {
      throw new Error(`the socket closed: ${event.code} ${event.reason}`);
    }
    const frame = decodeMachineSocketFrameV1(JSON.parse(event.data));
    if (frame.type === type) {
      return frame as Extract<MachineSocketFrameV1, { type: T }>;
    }
  }
}

/** The command ids in the next commands frame. */
export async function nextMachineFrame(
  socket: MachineSocketV1,
): Promise<string[]> {
  return (await nextMachineFrameOf(socket, "commands")).commands.map(
    (entry) => entry.commandId,
  );
}
