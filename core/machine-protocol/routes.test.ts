import { describe, expect, test } from "bun:test";
import {
  MACHINE_POLL_WAIT_PARAM_V1,
  MACHINE_ROUTES_V1,
  MACHINE_ROUTE_NAMES_V1,
  MACHINE_ROUTE_PREFIX_V1,
  decodeMachinePollWaitV1,
  machineRoutePathV1,
} from "./routes.ts";
import { MACHINE_LIMITS_V1, MachineDecodeError } from "./protocol.ts";

const MACHINE_ID = "994dc2ee-3f42-4a4d-9f2a-0a3f6f0d1b77";

describe("machine route table", () => {
  test("every machine-addressed route is public, and no browser route is", () => {
    const publicRoutes = MACHINE_ROUTE_NAMES_V1.filter(
      (name) => MACHINE_ROUTES_V1[name].publicRoute,
    );
    expect(publicRoutes).toEqual(["enroll", "poll", "claim", "result"]);
    // Public means "no session", never "no authority": every public route is
    // addressed by the machine, which presents a token instead.
    for (const name of publicRoutes) {
      expect(MACHINE_ROUTES_V1[name].audience).toBe("machine");
    }
    for (const name of MACHINE_ROUTE_NAMES_V1) {
      const route = MACHINE_ROUTES_V1[name];
      if (route.audience === "browser") expect(route.publicRoute).toBe(false);
      expect(route.template.startsWith(MACHINE_ROUTE_PREFIX_V1)).toBe(true);
    }
  });

  test("builds each concrete path", () => {
    expect(machineRoutePathV1("pair")).toBe("/api/machines/pair");
    expect(machineRoutePathV1("enroll")).toBe("/api/machines/enroll");
    expect(machineRoutePathV1("list")).toBe("/api/machines");
    expect(machineRoutePathV1("poll", { machineId: MACHINE_ID })).toBe(
      `/api/machines/${MACHINE_ID}/poll`,
    );
    expect(
      machineRoutePathV1("poll", { machineId: MACHINE_ID, waitSeconds: 25 }),
    ).toBe(`/api/machines/${MACHINE_ID}/poll?${MACHINE_POLL_WAIT_PARAM_V1}=25`);
    expect(machineRoutePathV1("revoke", { machineId: MACHINE_ID })).toBe(
      `/api/machines/${MACHINE_ID}/revoke`,
    );
    expect(
      machineRoutePathV1("claim", {
        machineId: MACHINE_ID,
        commandId: "tool:3:1:0",
      }),
    ).toBe(`/api/machines/${MACHINE_ID}/commands/tool%3A3%3A1%3A0/claim`);
    expect(
      machineRoutePathV1("result", {
        machineId: MACHINE_ID,
        commandId: "tool:3:1:0",
      }),
    ).toBe(`/api/machines/${MACHINE_ID}/commands/tool%3A3%3A1%3A0/result`);
  });

  test("refuses a missing or unsafe segment rather than emitting one", () => {
    expect(() => machineRoutePathV1("poll")).toThrow(/needs a valid machineId/);
    expect(() =>
      machineRoutePathV1("claim", { machineId: MACHINE_ID }),
    ).toThrow(/needs a valid commandId/);
    for (const bad of ["../../admin", "a b", "", "-x"]) {
      expect(() => machineRoutePathV1("poll", { machineId: bad })).toThrow(
        MachineDecodeError,
      );
    }
  });

  test("no template leaves an unsubstituted parameter behind", () => {
    for (const name of MACHINE_ROUTE_NAMES_V1) {
      const path = machineRoutePathV1(name, {
        machineId: MACHINE_ID,
        commandId: "tool:3:1:0",
      });
      expect(path).not.toContain(":machineId");
      expect(path).not.toContain(":commandId");
    }
  });
});

describe("poll wait", () => {
  test("accepts the ceiling from a number or a query string", () => {
    expect(decodeMachinePollWaitV1(0)).toBe(0);
    expect(decodeMachinePollWaitV1("25")).toBe(25);
    expect(decodeMachinePollWaitV1(MACHINE_LIMITS_V1.pollMaxWaitSeconds)).toBe(
      MACHINE_LIMITS_V1.pollMaxWaitSeconds,
    );
  });

  test("refuses a longer hold rather than silently clamping it", () => {
    // A silently clamped wait is a backoff the agent believes it does not need.
    for (const bad of [
      MACHINE_LIMITS_V1.pollMaxWaitSeconds + 1,
      "26",
      -1,
      1.5,
      "twenty",
      null,
    ]) {
      expect(() => decodeMachinePollWaitV1(bad)).toThrow(MachineDecodeError);
    }
  });
});
