// A registered machine's socket, as the User Durable Object holds it.
//
// The gateway verifies the machine token at the edge and forwards the upgrade
// here with what it proved in internal headers, the way the Bot-state channel
// carries identity. The token itself stops at the gateway: what crosses is its
// claims and its digest, and the Durable Object checks the digest against the
// machine record before it accepts anything.
//
// The sockets are hibernating and tagged by machine, so an idle desktop costs
// nothing and presence is simply whether a socket with that tag is open.

import {
  MachineTokenError,
  machineTokenClaimsV1,
  type MachineSocketFrameV1,
} from "@frockbot/core/machine-protocol";
import type { MachineCallV1 } from "@frockbot/app/machine/backend";
import type { MachineSocketsV1 } from "@frockbot/app/machine/user";

export const MACHINE_SOCKET_INTERNAL_PATH_V1 = "/internal/machine-socket/v1";

const USER_HEADER = "x-frockbot-user-id";
const MACHINE_HEADER = "x-frockbot-machine-id";
const CLAIMS_HEADER = "x-frockbot-machine-claims";
const DIGEST_HEADER = "x-frockbot-machine-token-digest";
const DIGEST = /^[0-9a-f]{64}$/;
const OPEN = 1;

export function machineSocketTagV1(machineId: string): string {
  return `machine:${machineId}`;
}

/** What each accepted socket carries through hibernation. */
export interface MachineSocketAttachmentV1 {
  machineId: string;
  tokenDigest: string;
  keyVersion: number;
}

/** The upgrade, as the gateway hands it to the User Durable Object. */
export function internalMachineSocketRequestV1(
  userId: string,
  call: MachineCallV1,
  request: Request,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set(USER_HEADER, userId);
  headers.set(MACHINE_HEADER, call.machineId);
  headers.set(CLAIMS_HEADER, JSON.stringify(call.claims));
  headers.set(DIGEST_HEADER, call.tokenDigest);
  return new Request(
    new URL(
      MACHINE_SOCKET_INTERNAL_PATH_V1,
      "https://user-configuration.internal",
    ),
    { method: "GET", headers },
  );
}

/** The forwarded call, or a refusal. */
export function readMachineSocketCallV1(request: Request): {
  userId: string;
  call: MachineCallV1;
} {
  const userId = request.headers.get(USER_HEADER);
  const machineId = request.headers.get(MACHINE_HEADER);
  const claims = request.headers.get(CLAIMS_HEADER);
  const tokenDigest = request.headers.get(DIGEST_HEADER);
  if (!userId || !machineId || !claims || !tokenDigest) {
    throw new MachineTokenError(401, "machine token is required");
  }
  if (!DIGEST.test(tokenDigest)) {
    throw new MachineTokenError(401, "machine token is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(claims);
  } catch {
    throw new MachineTokenError(401, "machine token is invalid");
  }
  return {
    userId,
    call: { machineId, claims: machineTokenClaimsV1(parsed), tokenDigest },
  };
}

/** The Contribution's view of the sockets, over the Durable Object's own list. */
export function durableObjectMachineSocketsV1(
  ctx: DurableObjectState,
): MachineSocketsV1 {
  const open = (machineId: string): WebSocket[] =>
    ctx
      .getWebSockets(machineSocketTagV1(machineId))
      .filter((socket) => socket.readyState === OPEN);
  return {
    push(machineId: string, frame: MachineSocketFrameV1): void {
      if (frame.commands.length === 0) return;
      const encoded = JSON.stringify(frame);
      for (const socket of open(machineId)) {
        try {
          socket.send(encoded);
        } catch {
          // A socket that cannot take a frame is closing; the queue is durable
          // and the machine is sent the command again when it reconnects.
        }
      }
    },
    connected: (machineId) => open(machineId).length > 0,
    close(machineId: string, code: number, reason: string): void {
      for (const socket of ctx.getWebSockets(machineSocketTagV1(machineId))) {
        try {
          socket.close(code, reason);
        } catch {
          // Already closed.
        }
      }
    },
  };
}
