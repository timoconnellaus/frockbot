// The registered-machine gateway Contribution: seven routes, on two doors.
//
// Three are ordinary authenticated routes beside `/api/settings` — the browser
// asks for a pairing code, reads the registry, and revokes a machine:
//
//   POST /api/machines/pair          mint a one-time, five-minute code
//   GET  /api/machines               the `ListMachines` projection
//   POST /api/machines/:id/revoke    kill every token this machine holds
//
// Four are not authenticated at all, because the caller is a program on
// somebody's laptop and has no session:
//
//   POST /api/machines/enroll                             bearer: pairing code
//   GET  /api/machines/:id/poll?wait=25                   bearer: machine token
//   POST /api/machines/:id/commands/:commandId/claim      bearer: machine token
//   POST /api/machines/:id/commands/:commandId/result     bearer: machine token
//
// Those four are `publicRoute`s: they run at the seam in
// `apps/cloudflare/src/gateway.ts` that executes *before* session
// authentication, exactly where `plugin-routines`' webhook runs. Public means
// "no session", never "no authority" — and the order of the checks is the
// whole design, port for port from that webhook:
//
//  1. The presented bearer is verified against the deployment secret, in
//     constant time. The gateway is stateless: without claims it could not
//     address a Durable Object at all without creating one on an anonymous
//     caller's word.
//  2. Only then is the object addressed, and only with the claims a token that
//     was minted here carries. Inside, the digest is checked against the
//     machine record — the authority — so revocation is effective on the very
//     next call.
//
// Nothing here holds state, and nothing here decides who owns a machine. The
// User Durable Object refuses any RPC naming a User it is not.

import {
  MACHINE_POLL_WAIT_PARAM_V1,
  MACHINE_ROUTE_PREFIX_V1,
  MachineDecodeError,
  MachineTokenError,
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineIdV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachinePairingRequestV1,
  decodeMachinePollResultV1,
  decodeMachinePollWaitV1,
  decodeMachineResultReceiptV1,
  machineBearerTokenV1,
  machineTokenDigestV1,
  verifyMachineTokenV1,
  type MachineClaimReceiptV1,
  type MachineEnrollmentReceiptV1,
  type MachineListViewV1,
  type MachinePairingOfferV1,
  type MachinePollResultV1,
  type MachineResultReceiptV1,
  type MachineTokenClaimsV1,
} from "@frockbot/machine-protocol";
import type { Plugin } from "cordis";
import { verifyMachinePairingCodeV1 } from "./pairing.js";

/** What one machine call carries into the User Durable Object. */
export interface MachineCallV1 {
  machineId: string;
  /** The token's own claims, verified at the edge. */
  claims: MachineTokenClaimsV1;
  /**
   * `SHA-256(token)`, hex. The token itself never crosses this seam: the
   * authority compares digests, so nothing downstream is handed a key.
   */
  tokenDigest: string;
}

export interface MachineGatewayHostV1 {
  /**
   * The HMAC secret every machine token and pairing code is signed with, or
   * nothing. Absent means the door is closed: enrollment and every machine
   * route answer 503 rather than admitting an unverified caller.
   */
  machineTokenSecret?: string;
  createMachinePairing(
    userId: string,
    request: { label?: string },
  ): Promise<MachinePairingOfferV1>;
  enrollMachine(
    userId: string,
    input: { machineId: string; enrollment: unknown },
  ): Promise<MachineEnrollmentReceiptV1>;
  pollMachine(
    userId: string,
    call: MachineCallV1 & { waitSeconds: number },
  ): Promise<MachinePollResultV1>;
  claimMachineCommand(
    userId: string,
    call: MachineCallV1 & { commandId: string },
  ): Promise<MachineClaimReceiptV1>;
  recordMachineResult(
    userId: string,
    call: MachineCallV1 & { commandId: string; result: unknown },
  ): Promise<MachineResultReceiptV1>;
  listMachines(userId: string): Promise<MachineListViewV1>;
  revokeMachine(userId: string, machineId: string): Promise<MachineListViewV1>;
}

export interface MachineBackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const PAIR = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}/pair$`);
const ENROLL = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}/enroll$`);
const LIST = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}$`);
const REVOKE = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/revoke$`);
const POLL = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/poll$`);
const CLAIM = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/commands/([^/]+)/claim$`,
);
const RESULT = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/commands/([^/]+)/result$`,
);

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pathSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new MachineDecodeError(`${label} is invalid`);
  }
}

/**
 * A machine the caller does not own, one that does not exist, and one whose
 * key has been revoked are the same answer. Which it was is not a prober's.
 */
function errorResponse(error: unknown): Response {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "MachineTokenError" ||
      error.name === "MachineRegistryError") &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return jsonError(
      error.status,
      error instanceof Error ? error.message : "machine request failed",
    );
  }
  if (
    error instanceof MachineDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "MachineDecodeError")
  ) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "machine request is invalid",
    );
  }
  return jsonError(
    500,
    error instanceof Error ? error.message : "machine request failed",
  );
}

/** The bearer a machine route presents, or a refusal. */
function bearer(request: Request): string {
  const token = machineBearerTokenV1(request.headers.get("authorization"));
  if (!token) {
    throw new MachineTokenError(401, "machine token is required");
  }
  return token;
}

async function machineCall(
  secret: string,
  request: Request,
  machineIdSegment: string,
): Promise<MachineCallV1> {
  const token = bearer(request);
  const claims = await verifyMachineTokenV1(secret, token);
  const machineId = decodeMachineIdV1(
    pathSegment(machineIdSegment, "machineId"),
  );
  // The path and the key must agree. A token for one machine presented at
  // another's door is as good as forged.
  if (claims.m !== machineId) {
    throw new MachineTokenError(401, "machine token is invalid");
  }
  return { machineId, claims, tokenDigest: await machineTokenDigestV1(token) };
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new MachineDecodeError("machine request body is not JSON");
  }
}

export function createMachineBackendContribution(
  host: MachineGatewayHostV1,
): MachineBackendRouteContribution {
  const secretOrRefuse = (): string => {
    const secret = host.machineTokenSecret;
    if (!secret) {
      throw new MachineTokenError(
        503,
        "machine registration is not configured",
      );
    }
    return secret;
  };

  const contribution: MachineBackendRouteContribution = {
    packageId: "user-machine",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const userId = context.userId;
      const revoke = REVOKE.exec(url.pathname);
      const isPair = PAIR.test(url.pathname);
      const isList = LIST.test(url.pathname);
      if (!revoke && !isPair && !isList) return undefined;
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "machine routes take no query parameters");
      }
      try {
        if (isPair) {
          if (request.method !== "POST") {
            return jsonError(405, "method not allowed");
          }
          const requested = decodeMachinePairingRequestV1(
            await readJsonBody(request),
          );
          return Response.json(
            decodeMachinePairingOfferV1(
              await host.createMachinePairing(userId, requested),
            ),
          );
        }
        if (revoke) {
          if (request.method !== "POST") {
            return jsonError(405, "method not allowed");
          }
          const machineId = decodeMachineIdV1(
            pathSegment(revoke[1]!, "machineId"),
          );
          return Response.json(
            decodeMachineListViewV1(
              await host.revokeMachine(userId, machineId),
            ),
          );
        }
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        return Response.json(
          decodeMachineListViewV1(await host.listMachines(userId)),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };

  contribution.publicRoute = async (request, url) => {
    const enroll = ENROLL.test(url.pathname);
    const poll = POLL.exec(url.pathname);
    const claim = CLAIM.exec(url.pathname);
    const result = RESULT.exec(url.pathname);
    if (!enroll && !poll && !claim && !result) return undefined;
    try {
      const secret = secretOrRefuse();
      if (enroll) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        // The pairing code is both the bearer and a field of the body: the
        // header is what the edge verifies, and the body is what the authority
        // hashes against the offer it stored. They must be the same code.
        const code = bearer(request);
        const claims = await verifyMachinePairingCodeV1(secret, code);
        const body = await readJsonBody(request);
        const presented = (body as { code?: unknown }).code;
        if (presented !== code) {
          throw new MachineTokenError(401, "machine pairing code is invalid");
        }
        return Response.json(
          decodeMachineEnrollmentReceiptV1(
            await host.enrollMachine(claims.userId, {
              machineId: claims.machineId,
              enrollment: body,
            }),
          ),
        );
      }
      if (poll) {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        for (const key of url.searchParams.keys()) {
          if (key !== MACHINE_POLL_WAIT_PARAM_V1) {
            return jsonError(400, `machine poll query.${key} is not allowed`);
          }
        }
        const call = await machineCall(secret, request, poll[1]!);
        const raw = url.searchParams.get(MACHINE_POLL_WAIT_PARAM_V1);
        const waitSeconds = raw === null ? 0 : decodeMachinePollWaitV1(raw);
        return Response.json(
          decodeMachinePollResultV1(
            await host.pollMachine(call.claims.u, { ...call, waitSeconds }),
          ),
        );
      }
      const matched = (claim ?? result)!;
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      const call = await machineCall(secret, request, matched[1]!);
      const commandId = pathSegment(matched[2]!, "commandId");
      if (claim) {
        return Response.json(
          decodeMachineClaimReceiptV1(
            await host.claimMachineCommand(call.claims.u, {
              ...call,
              commandId,
            }),
          ),
        );
      }
      return Response.json(
        decodeMachineResultReceiptV1(
          await host.recordMachineResult(call.claims.u, {
            ...call,
            commandId,
            result: await readJsonBody(request),
          }),
        ),
      );
    } catch (error) {
      return errorResponse(error);
    }
  };
  return contribution;
}

export namespace createMachineBackendContribution {
  export function plugin(
    host: MachineGatewayHostV1,
    lifecycle: { mount(value: MachineBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createMachineBackendContribution(host));
  }
}
