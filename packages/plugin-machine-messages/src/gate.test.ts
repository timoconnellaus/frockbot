// The two gates that decide whether the Messages tools exist at all.
import { describe, expect, test } from "bun:test";
import type { MachineListEntryV1 } from "@frockbot/machine-protocol";
import {
  MACHINE_MESSAGES_SETTING_V1,
  machineMessagesEnabledV1,
  machineMessagesGateV1,
} from "./gate.js";

const NOW = "2026-09-01T00:00:00.000Z";

function entry(
  overrides: Partial<MachineListEntryV1> = {},
): MachineListEntryV1 {
  return {
    machineId: "mac-1",
    label: "Tims-M5-MacBook-Pro.local",
    platform: "macos",
    capabilities: ["exec", "files", "messages"],
    connected: true,
    lastSeenAt: NOW,
    registeredAt: NOW,
    ...overrides,
  };
}

describe("the feature gate", () => {
  test("a setting nobody has touched is off", () => {
    expect(machineMessagesEnabledV1(undefined)).toBe(false);
    expect(machineMessagesEnabledV1({})).toBe(false);
  });

  test("only true is on", () => {
    expect(
      machineMessagesEnabledV1({ [MACHINE_MESSAGES_SETTING_V1]: true }),
    ).toBe(true);
    for (const value of ["true", 1, "", 0, false] as const) {
      expect(
        machineMessagesEnabledV1({ [MACHINE_MESSAGES_SETTING_V1]: value }),
      ).toBe(false);
    }
  });

  test("off is off whatever the registry holds", () => {
    expect(
      machineMessagesGateV1({ enabled: false, machines: [entry()] }),
    ).toEqual({ status: "off" });
  });
});

describe("the capability gate", () => {
  test("a connected macOS machine reporting messages opens it", () => {
    expect(
      machineMessagesGateV1({ enabled: true, machines: [entry()] }),
    ).toEqual({ status: "ready", machineIds: ["mac-1"] });
  });

  test("every way a machine fails to qualify", () => {
    const refused: Array<Partial<MachineListEntryV1>> = [
      // Never reported the capability — the agent had no handlers behind it.
      { capabilities: ["exec", "files"] },
      // Not a Mac. The protocol refuses the claim at enrollment; this refuses
      // it again, because a registry row can outlive the build that wrote it.
      { platform: "linux", capabilities: ["exec", "files"] },
      // The laptop is asleep. A command has nowhere to go.
      { connected: false },
      // Revoked. The row is evidence, not a machine.
      { revokedAt: NOW },
    ];
    for (const overrides of refused) {
      expect(
        machineMessagesGateV1({
          enabled: true,
          machines: [entry(overrides)],
        }),
      ).toEqual({ status: "no-machine" });
    }
    expect(machineMessagesGateV1({ enabled: true, machines: [] })).toEqual({
      status: "no-machine",
    });
  });

  test("one qualifying machine among several is enough, and only it is named", () => {
    expect(
      machineMessagesGateV1({
        enabled: true,
        machines: [
          entry({
            machineId: "linux-1",
            platform: "linux",
            capabilities: ["exec"],
          }),
          entry({ machineId: "mac-asleep", connected: false }),
          entry({ machineId: "mac-2" }),
        ],
      }),
    ).toEqual({ status: "ready", machineIds: ["mac-2"] });
  });
});
