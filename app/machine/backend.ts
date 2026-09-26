// The registered-machine gateway Contribution: ten routes, on two doors.
//
// Three are ordinary authenticated routes beside `/api/settings` — the browser
// asks for a pairing code, reads the registry, and revokes a machine:
//
//   POST /api/machines/pair          mint a one-time, five-minute code
//   GET  /api/machines               the `ListMachines` projection
//   POST /api/machines/:id/revoke    kill every token this machine holds
//
// Nine are not authenticated at all, because the caller is a program on
// somebody's laptop and has no session:
//
//   POST /api/machines/enroll                             bearer: pairing code
//   GET  /api/machines/:id/socket                         bearer: machine token
//   POST /api/machines/:id/commands/:commandId/claim      bearer: machine token
//   POST /api/machines/:id/commands/:commandId/result     bearer: machine token
//   GET  /api/machines/:id/modules/:contentHash           bearer: machine token
//   POST /api/machines/:id/module-reports                 bearer: machine token
//   POST /api/machines/:id/module-events                  bearer: machine token
//   POST /api/machines/:id/module-calls/:callId/claim     bearer: machine token
//   POST /api/machines/:id/module-calls/:callId/result    bearer: machine token
//
// Those nine are `publicRoute`s: they run at the seam in
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
// The socket is an upgrade, and RPC cannot hand one over, so once the token
// checks out the request itself is forwarded to the User Durable Object, which
// accepts it as a hibernating WebSocket and pushes commands down it.
//
// Nothing here holds state, and nothing here decides who owns a machine. The
// User Durable Object refuses any request naming a User it is not.

import {
  MACHINE_ROUTE_PREFIX_V1,
  MachineDecodeError,
  MachineTokenError,
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineIdV1,
  decodeMachineListViewV1,
  decodeMachineModuleCallClaimReceiptV1,
  decodeMachineModuleCallResultReceiptV1,
  decodeMachineModuleEventsReceiptV1,
  decodeMachineModuleEventsV1,
  decodeMachineModuleReportsReceiptV1,
  decodeMachineModuleReportsV1,
  decodeMachinePairingOfferV1,
  decodeMachinePairingRequestV1,
  decodeMachineResultReceiptV1,
  machineBearerTokenV1,
  machineTokenDigestV1,
  verifyMachineTokenV1,
  type MachineClaimReceiptV1,
  type MachineEnrollmentReceiptV1,
  type MachineListViewV1,
  type MachineModuleCallClaimReceiptV1,
  type MachineModuleCallResultReceiptV1,
  type MachineModuleEventsReceiptV1,
  type MachineModuleEventsV1,
  type MachineModuleReportsReceiptV1,
  type MachineModuleReportsV1,
  type MachinePairingOfferV1,
  type MachineResultReceiptV1,
  type MachineTokenClaimsV1,
} from "@frockbot/core/machine-protocol";
import { sha256HexBytesV1 } from "@frockbot/core/crypto";
import { verifyMachinePairingCodeV1 } from "./pairing.js";
import { machinesDocumentV1 } from "./machines-document.js";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";

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
  /**
   * Hand a verified socket upgrade to the User Durable Object. The answer is
   * its 101, or its refusal.
   */
  openMachineSocket(
    userId: string,
    call: MachineCallV1,
    request: Request,
  ): Promise<Response>;
  claimMachineCommand(
    userId: string,
    call: MachineCallV1 & { commandId: string },
  ): Promise<MachineClaimReceiptV1>;
  recordMachineResult(
    userId: string,
    call: MachineCallV1 & { commandId: string; result: unknown },
  ): Promise<MachineResultReceiptV1>;
  /**
   * A device module's bytes, or undefined when the account's active
   * generation carries no module with that hash.
   */
  loadMachineModule(
    userId: string,
    call: MachineCallV1 & { contentHash: string },
  ): Promise<ArrayBuffer | undefined>;
  recordMachineModuleReports(
    userId: string,
    call: MachineCallV1 & { reports: MachineModuleReportsV1 },
  ): Promise<MachineModuleReportsReceiptV1>;
  /** The desktop starting a Plugin's call to its device module. */
  claimMachineModuleCall(
    userId: string,
    call: MachineCallV1 & { callId: string },
  ): Promise<MachineModuleCallClaimReceiptV1>;
  recordMachineModuleCallResult(
    userId: string,
    call: MachineCallV1 & { callId: string; result: unknown },
  ): Promise<MachineModuleCallResultReceiptV1>;
  /** Device-module events, answered once each is durably admitted. */
  recordMachineModuleEvents(
    userId: string,
    call: MachineCallV1 & { events: MachineModuleEventsV1 },
  ): Promise<MachineModuleEventsReceiptV1>;
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
const SOCKET = new RegExp(`^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/socket$`);
const CLAIM = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/commands/([^/]+)/claim$`,
);
const RESULT = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/commands/([^/]+)/result$`,
);
const MODULE = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/modules/([^/]+)$`,
);
const MODULE_REPORTS = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/module-reports$`,
);
const MODULE_CALL = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/module-calls/([^/]+)/(claim|result)$`,
);
const MODULE_EVENTS = new RegExp(
  `^${MACHINE_ROUTE_PREFIX_V1}/([^/]+)/module-events$`,
);
const CONTENT_HASH = /^[0-9a-f]{64}$/;

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
      // One parameter, on one route: `as=document` asks the registry read for
      // the same machines in the vocabulary the host renders every view in.
      const asDocument =
        isList &&
        request.method === "GET" &&
        url.searchParams.get("as") === "document";
      if ([...url.searchParams.keys()].length > (asDocument ? 1 : 0)) {
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
        const view = decodeMachineListViewV1(await host.listMachines(userId));
        return Response.json(asDocument ? machinesDocumentV1(view) : view);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };

  contribution.publicRoute = async (request, url) => {
    const enroll = ENROLL.test(url.pathname);
    const socket = SOCKET.exec(url.pathname);
    const claim = CLAIM.exec(url.pathname);
    const result = RESULT.exec(url.pathname);
    const module = MODULE.exec(url.pathname);
    const moduleReports = MODULE_REPORTS.exec(url.pathname);
    const moduleCall = MODULE_CALL.exec(url.pathname);
    const moduleEvents = MODULE_EVENTS.exec(url.pathname);
    if (
      !enroll &&
      !socket &&
      !claim &&
      !result &&
      !module &&
      !moduleReports &&
      !moduleCall &&
      !moduleEvents
    ) {
      return undefined;
    }
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
      if (socket) {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        if ([...url.searchParams.keys()].length > 0) {
          return jsonError(400, "the machine socket takes no query parameters");
        }
        // The token first, so a plain GET tells an agent whose upgrade failed
        // opaquely whether its token is dead (401) or only its socket (426).
        const call = await machineCall(secret, request, socket[1]!);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return jsonError(426, "WebSocket upgrade required");
        }
        return await host.openMachineSocket(call.claims.u, call, request);
      }
      if (module) {
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        const call = await machineCall(secret, request, module[1]!);
        const contentHash = module[2]!;
        const bytes = CONTENT_HASH.test(contentHash)
          ? await host.loadMachineModule(call.claims.u, {
              ...call,
              contentHash,
            })
          : undefined;
        if (bytes === undefined) {
          return jsonError(404, "module was not found");
        }
        // The hash is the whole promise this route makes, and the desktop
        // checks it again; a stored object that no longer matches is refused
        // here rather than handed to a process to run.
        if ((await sha256HexBytesV1(new Uint8Array(bytes))) !== contentHash) {
          return jsonError(502, "module failed verification");
        }
        return new Response(bytes, {
          headers: {
            "content-type": "application/javascript",
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (moduleReports) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const call = await machineCall(secret, request, moduleReports[1]!);
        return Response.json(
          decodeMachineModuleReportsReceiptV1(
            await host.recordMachineModuleReports(call.claims.u, {
              ...call,
              reports: decodeMachineModuleReportsV1(
                await readJsonBody(request),
              ),
            }),
          ),
        );
      }
      if (moduleCall) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const call = await machineCall(secret, request, moduleCall[1]!);
        const callId = pathSegment(moduleCall[2]!, "callId");
        if (moduleCall[3] === "claim") {
          return Response.json(
            decodeMachineModuleCallClaimReceiptV1(
              await host.claimMachineModuleCall(call.claims.u, {
                ...call,
                callId,
              }),
            ),
          );
        }
        return Response.json(
          decodeMachineModuleCallResultReceiptV1(
            await host.recordMachineModuleCallResult(call.claims.u, {
              ...call,
              callId,
              // Decoded by the authority, after the token: a dead token is
              // a 401 whatever it carried.
              result: await readJsonBody(request),
            }),
          ),
        );
      }
      if (moduleEvents) {
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const call = await machineCall(secret, request, moduleEvents[1]!);
        return Response.json(
          decodeMachineModuleEventsReceiptV1(
            await host.recordMachineModuleEvents(call.claims.u, {
              ...call,
              events: decodeMachineModuleEventsV1(await readJsonBody(request)),
            }),
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

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  MachineGatewayHostV1,
  MachineBackendRouteContribution
>({
  specifier: "@frockbot/app/machine/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createMachineBackendContribution(host)),
});
