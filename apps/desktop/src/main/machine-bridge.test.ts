// The renderer's one channel to the device agent.
//
// Two things are asserted: a frame that is not the hosted application reaches
// nothing, and no request shape outside the three verbs is decoded. The status
// coming back is decoded too, which is what keeps a future agent from
// answering the renderer with something it should not have.

import { describe, expect, test } from "bun:test";
import {
  MACHINE_AGENT_PAIR_COMMAND_V1,
  MACHINE_AGENT_STATUS_COMMAND_V1,
  MACHINE_AGENT_UNPAIR_COMMAND_V1,
} from "@frockbot/plugin-user-machine/desktop";
import { createMachineBridgeHandlerV1 } from "./machine-bridge.js";
import { decodeDesktopMachineRequest } from "./desktop-api.js";

const ORIGIN = "https://bot.frockbot.com";

const STATUS = {
  schemaVersion: 1,
  enrolled: true,
  running: true,
  machineId: "m-1",
  label: "Tims-M5-MacBook-Pro.local",
  failures: 0,
};

function bridge(): {
  handle: ReturnType<typeof createMachineBridgeHandlerV1>;
  invoked: Array<[string, unknown]>;
} {
  const invoked: Array<[string, unknown]> = [];
  return {
    invoked,
    handle: createMachineBridgeHandlerV1(
      {
        desktopCommands: {
          invoke: (commandId: string, input: unknown) => {
            invoked.push([commandId, input]);
            return Promise.resolve(STATUS) as never;
          },
        },
      },
      ORIGIN,
    ),
  };
}

describe("machine agent request", () => {
  test("three verbs, and a pairing code that is bounded", () => {
    expect(
      decodeDesktopMachineRequest({ schemaVersion: 1, type: "machine/status" }),
    ).toEqual({ schemaVersion: 1, type: "machine/status" });
    expect(
      decodeDesktopMachineRequest({
        schemaVersion: 1,
        type: "machine/pair",
        code: "abc",
      }),
    ).toEqual({ schemaVersion: 1, type: "machine/pair", code: "abc" });
    for (const invalid of [
      { schemaVersion: 1, type: "machine/pair" },
      { schemaVersion: 1, type: "machine/pair", code: "" },
      { schemaVersion: 1, type: "machine/pair", code: "x".repeat(513) },
      { schemaVersion: 1, type: "machine/status", extra: 1 },
      { schemaVersion: 2, type: "machine/status" },
      { schemaVersion: 1, type: "machine/run", command: "rm -rf /" },
    ]) {
      expect(() => decodeDesktopMachineRequest(invalid)).toThrow(
        "invalid machine agent request",
      );
    }
  });
});

describe("machine agent bridge", () => {
  test("each verb reaches its own desktop command", async () => {
    const mounted = bridge();
    await mounted.handle(`${ORIGIN}/`, {
      schemaVersion: 1,
      type: "machine/status",
    });
    await mounted.handle(`${ORIGIN}/settings`, {
      schemaVersion: 1,
      type: "machine/pair",
      code: "pairing-code",
    });
    await mounted.handle(`${ORIGIN}/`, {
      schemaVersion: 1,
      type: "machine/unpair",
    });
    expect(mounted.invoked).toEqual([
      [MACHINE_AGENT_STATUS_COMMAND_V1, {}],
      [MACHINE_AGENT_PAIR_COMMAND_V1, { code: "pairing-code" }],
      [MACHINE_AGENT_UNPAIR_COMMAND_V1, {}],
    ]);
  });

  test("a frame that is not the hosted application reaches nothing", async () => {
    const mounted = bridge();
    for (const sender of [
      undefined,
      "https://evil.example.com/",
      "file:///tmp/page.html",
      "not a url",
    ]) {
      await expect(
        mounted.handle(sender, { schemaVersion: 1, type: "machine/status" }),
      ).rejects.toThrow("untrusted renderer");
    }
    expect(mounted.invoked).toEqual([]);
  });

  test("an answer that is not a status does not reach the renderer", async () => {
    const handle = createMachineBridgeHandlerV1(
      {
        desktopCommands: {
          invoke: () => Promise.resolve({ token: "machine-token" }) as never,
        },
      },
      ORIGIN,
    );
    await expect(
      handle(`${ORIGIN}/`, { schemaVersion: 1, type: "machine/status" }),
    ).rejects.toThrow("invalid machine agent status");
  });
});
