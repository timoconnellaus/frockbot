// The route table, declared once.
//
// Three parties address these paths — the browser, the gateway that registers
// them, and the device agent that dials them — and each would otherwise hold
// its own string. One table means the agent cannot poll a path the gateway
// does not serve, and a test cannot pass against a route nobody registered.
//
// `audience` and `publicRoute` are the load-bearing columns. `poll`, `claim`
// and `result` are declared public because they carry a *machine token*, not a
// session: they run at the seam in `apps/cloudflare/src/gateway.ts` that
// executes before session authentication, which `plugin-routines`' webhook
// already uses. Public here means "no session", never "no authority" — the
// token is verified at the edge and re-checked against the machine record's
// digest inside the User Durable Object.

import { MACHINE_LIMITS_V1, MachineDecodeError } from "./protocol.js";

export const MACHINE_ROUTE_PREFIX_V1 = "/api/machines";

export type MachineRouteNameV1 =
  "pair" | "enroll" | "poll" | "claim" | "result" | "list" | "revoke";

export interface MachineRouteV1 {
  method: "GET" | "POST";
  /** The template the gateway registers, with `:machineId` / `:commandId`. */
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
  poll: {
    method: "GET",
    template: `${MACHINE_ROUTE_PREFIX_V1}/:machineId/poll`,
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

/** The query parameter a long poll asks its hold with. */
export const MACHINE_POLL_WAIT_PARAM_V1 = "wait";

export interface MachineRouteParamsV1 {
  machineId?: string;
  commandId?: string;
  /** `poll` only: seconds to hold, bounded by `pollMaxWaitSeconds`. */
  waitSeconds?: number;
}

const SEGMENT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/**
 * The concrete path for one route.
 *
 * Every substituted segment is checked against the same identifier rule the
 * decoders use and then percent-encoded: a `commandId` is an `effectId` and
 * carries colons, which are legal in a path segment, but nothing here trusts
 * that an id it was handed is one it minted.
 */
export function machineRoutePathV1(
  name: MachineRouteNameV1,
  params: MachineRouteParamsV1 = {},
): string {
  const route = MACHINE_ROUTES_V1[name];
  if (!route) {
    throw new MachineDecodeError(`unknown machine route: ${String(name)}`);
  }
  const path = route.template.replace(
    /:(machineId|commandId)/g,
    (_match, key: "machineId" | "commandId") => {
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
  if (name !== "poll" || params.waitSeconds === undefined) return path;
  const wait = decodeMachinePollWaitV1(params.waitSeconds);
  return `${path}?${MACHINE_POLL_WAIT_PARAM_V1}=${wait}`;
}

/**
 * How long a poll may be held, from a number or from the raw query string.
 *
 * The ceiling is the protocol's, not the caller's: a machine that asks to be
 * held for an hour is asking a Worker to hold a request past every limit it
 * has, so the value is refused rather than silently clamped — a silently
 * clamped wait is a backoff the agent thinks it does not need.
 */
export function decodeMachinePollWaitV1(
  input: unknown,
  label = "machine poll wait",
): number {
  const value =
    typeof input === "string" && /^[0-9]{1,4}$/.test(input)
      ? Number.parseInt(input, 10)
      : input;
  if (!Number.isSafeInteger(value)) {
    throw new MachineDecodeError(`${label} must be an integer`);
  }
  const seconds = value as number;
  if (seconds < 0 || seconds > MACHINE_LIMITS_V1.pollMaxWaitSeconds) {
    throw new MachineDecodeError(
      `${label} must be between 0 and ${MACHINE_LIMITS_V1.pollMaxWaitSeconds}`,
      "limit-exceeded",
    );
  }
  return seconds;
}
