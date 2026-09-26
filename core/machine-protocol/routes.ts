// The route table, declared once.
//
// Three parties address these paths — the browser, the gateway that registers
// them, and the device agent that dials them — and each would otherwise hold
// its own string. One table means the agent cannot dial a path the gateway
// does not serve, and a test cannot pass against a route nobody registered.
//
// `audience` and `publicRoute` are the load-bearing columns. `socket`, `claim`,
// `result`, `module`, `moduleReports` and `moduleEvents` are declared public
// because they carry a *machine token*, not a session: they run at the seam in `apps/cloudflare/src/gateway.ts` that
// executes before session authentication, which `plugin-routines`' webhook
// already uses. Public here means "no session", never "no authority" — the
// token is verified at the edge and re-checked against the machine record's
// digest inside the User Durable Object.

import { MACHINE_LIMITS_V1, MachineDecodeError } from "./protocol.js";

export const MACHINE_ROUTE_PREFIX_V1 = "/api/machines";

export type MachineRouteNameV1 =
  | "pair"
  | "enroll"
  | "socket"
  | "claim"
  | "result"
  | "module"
  | "moduleReports"
  | "moduleEvents"
  | "list"
  | "revoke";

export interface MachineRouteV1 {
  method: "GET" | "POST";
  /** The template the gateway registers, with its `:parameters`. */
  template: string;
  /** Who presents at this route. */
  audience: "browser" | "machine";
  /** Declared `publicRoute` on the gateway contribution: bearer, not session. */
  publicRoute: boolean;
}

export const MACHINE_ROUTES_V1: Readonly<
  Record<MachineRouteNameV1, MachineRouteV1>
> = {
  pair: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/pair`,
    audience: "browser",
    publicRoute: false,
  },
  enroll: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/enroll`,
    audience: "machine",
    publicRoute: true,
  },
  socket: {
    method: "GET",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/socket`,
    audience: "machine",
    publicRoute: true,
  },
  claim: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/commands/:commandId/claim`,
    audience: "machine",
    publicRoute: true,
  },
  result: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/commands/:commandId/result`,
    audience: "machine",
    publicRoute: true,
  },
  module: {
    method: "GET",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/modules/:contentHash`,
    audience: "machine",
    publicRoute: true,
  },
  moduleReports: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/module-reports`,
    audience: "machine",
    publicRoute: true,
  },
  moduleEvents: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/module-events`,
    audience: "machine",
    publicRoute: true,
  },
  list: {
    method: "GET",
    template: MACHINE_ROUTE_PREFIX_V1,
    audience: "browser",
    publicRoute: false,
  },
  revoke: {
    method: "POST",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/revoke`,
    audience: "browser",
    publicRoute: false,
  },
} as const;

export const MACHINE_ROUTE_NAMES_V1 = Object.keys(
  MACHINE_ROUTES_V1,
) as MachineRouteNameV1[];

export interface MachineRouteParamsV1 {
  machineId?: string;
  commandId?: string;
  contentHash?: string;
}

const SEGMENT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/**
 * The concrete path for one route.
 *
 * Every substituted segment is checked against the same identifier rule the
 * decoders use and then percent-encoded: an identifier may carry colons,
 * which are legal in a path segment, but nothing here trusts that an id it
 * was handed is one it minted.
 */
export function machineRoutePathV1(
  name: MachineRouteNameV1,
  params: MachineRouteParamsV1 = {},
): string {
  const route = MACHINE_ROUTES_V1[name];
  if (!route) {
    throw new MachineDecodeError(`unknown machine route: ${String(name)}`);
  }
  return route.template.replace(
    /:(machineId|commandId|contentHash)/g,
    (_match, key: "machineId" | "commandId" | "contentHash") => {
      const value = params[key];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MACHINE_LIMITS_V1.identifier ||
        !SEGMENT_SAFE.test(value)
      ) {
        throw new MachineDecodeError(
          `machine route ${name} needs a valid ${key}`,
        );
      }
      return encodeURIComponent(value);
    },
  );
}
