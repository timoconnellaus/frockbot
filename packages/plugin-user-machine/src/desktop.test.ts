// The `trusted-main` Contribution, mounted on fake capabilities.
//
// No Electron here — and that is the assertion as much as the convenience: the
// contribution is wired through cordis services, so the same plugin the
// desktop shell mounts runs under `bun test` against a fake host and a fake
// keychain.

import { describe, expect, test } from "bun:test";
import {
  DesktopCommandRegistry,
  DesktopMachineHostCapability,
  DesktopSecretStoreCapability,
  type DesktopMachineExecResult,
  type DesktopMachineFileResult,
  type DesktopMachineIdentity,
} from "@frockbot/desktop-core";
import { Context } from "cordis";
import {
  MACHINE_AGENT_PAIR_COMMAND_V1,
  MACHINE_AGENT_STATUS_COMMAND_V1,
  MACHINE_AGENT_UNPAIR_COMMAND_V1,
  MACHINE_DESKTOP_CAPABILITIES_V1,
  machineDesktopCapabilitiesV1,
  MACHINE_TOKEN_SECRET_KEY_V1,
  decodeMachineEmptyCommandInputV1,
  decodeMachinePairCommandInputV1,
  machineDesktopPlugin,
  machineSecretStoreV1,
} from "./desktop.js";
import {
  decodeMachineDeviceAgentStatusV1,
  type MachineDeviceAgentStatusV1,
} from "./device.js";

const ORIGIN = "https://bot.example.com";

class FakeMachineHost extends DesktopMachineHostCapability {
  identity(): DesktopMachineIdentity {
    return { label: "Tims-M5-MacBook-Pro.local", platform: "macos" };
  }
  exec(): Promise<DesktopMachineExecResult> {
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  }
  readFile(): Promise<DesktopMachineFileResult> {
    return Promise.resolve({ bytesBase64: "", truncated: false });
  }
}

class MemorySecretStore extends DesktopSecretStoreCapability {
  readonly held = new Map<string, string>();
  read(key: string): Promise<string | undefined> {
    return Promise.resolve(this.held.get(key));
  }
  write(key: string, value: string): Promise<void> {
    this.held.set(key, value);
    return Promise.resolve();
  }
  clear(key: string): Promise<void> {
    this.held.delete(key);
    return Promise.resolve();
  }
}

async function mount(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ root: Context; secrets: MemorySecretStore }> {
  const root = new Context();
  await root.plugin(DesktopCommandRegistry);
  await root.plugin(FakeMachineHost);
  await root.plugin(MemorySecretStore);
  await root.plugin(machineDesktopPlugin, {
    origin: ORIGIN,
    agentVersion: "0.0.1",
    fetch: fetchImpl,
    autoStart: false,
  });
  return { root, secrets: root.desktopSecretStore as MemorySecretStore };
}

describe("machine desktop contribution inputs", () => {
  test("a pairing code is required, trimmed, and alone", () => {
    expect(decodeMachinePairCommandInputV1({ code: " abc " })).toEqual({
      code: "abc",
    });
    expect(() => decodeMachinePairCommandInputV1({ code: "" })).toThrow();
    expect(() =>
      decodeMachinePairCommandInputV1({ code: "abc", extra: 1 }),
    ).toThrow();
    expect(() => decodeMachinePairCommandInputV1("abc")).toThrow();
  });

  test("the other two commands take nothing at all", () => {
    expect(decodeMachineEmptyCommandInputV1({})).toEqual({});
    expect(() => decodeMachineEmptyCommandInputV1({ code: "x" })).toThrow();
  });

  test("the secret store is narrowed to the agent's own key", async () => {
    const keys: string[] = [];
    const narrowed = machineSecretStoreV1({
      read: (key: string) => {
        keys.push(key);
        return Promise.resolve(undefined);
      },
      write: (key: string) => {
        keys.push(key);
        return Promise.resolve();
      },
      clear: (key: string) => {
        keys.push(key);
        return Promise.resolve();
      },
    });
    await narrowed.read();
    await narrowed.write("value");
    await narrowed.clear();
    expect(new Set(keys)).toEqual(new Set([MACHINE_TOKEN_SECRET_KEY_V1]));
  });
});

describe("machine desktop contribution", () => {
  test("registers exactly three commands and removes them on disposal", async () => {
    const { root } = await mount(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    expect(
      root.desktopCommands
        .list()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(
      [
        MACHINE_AGENT_PAIR_COMMAND_V1,
        MACHINE_AGENT_STATUS_COMMAND_V1,
        MACHINE_AGENT_UNPAIR_COMMAND_V1,
      ].sort(),
    );
    const commands = root.desktopCommands;
    await root.fiber.dispose();
    await expect(
      commands.invoke(MACHINE_AGENT_STATUS_COMMAND_V1, {}),
    ).rejects.toThrow("is unavailable");
  });

  test("pairing enrols with the host's own identity and keeps the token", async () => {
    const bodies: string[] = [];
    const { root, secrets } = await mount((input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      if (input.endsWith("/enroll")) {
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            machineId: "m-1",
            token: "machine-token",
            keyVersion: 1,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          schemaVersion: 1,
          commands: [],
          serverTime: "2026-09-01T00:00:00.000Z",
        }),
      );
    });

    const status = decodeMachineDeviceAgentStatusV1(
      await root.desktopCommands.invoke<MachineDeviceAgentStatusV1>(
        MACHINE_AGENT_PAIR_COMMAND_V1,
        { code: "pairing-code" },
      ),
    );

    expect(status.enrolled).toBe(true);
    expect(status.label).toBe("Tims-M5-MacBook-Pro.local");
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      label: "Tims-M5-MacBook-Pro.local",
      platform: "macos",
      // Row 57g's second gate: no agent reports `messages` until the macOS
      // handlers exist.
      capabilities: [...MACHINE_DESKTOP_CAPABILITIES_V1],
    });
    expect(secrets.held.get(MACHINE_TOKEN_SECRET_KEY_V1)).toContain(
      "machine-token",
    );

    await root.desktopCommands.invoke(MACHINE_AGENT_UNPAIR_COMMAND_V1, {});
    expect(secrets.held.has(MACHINE_TOKEN_SECRET_KEY_V1)).toBe(false);
    await root.fiber.dispose();
  });

  test("status is readable before anything has been paired", async () => {
    const { root } = await mount(() =>
      Promise.reject(new Error("nothing should be dialled")),
    );
    expect(
      decodeMachineDeviceAgentStatusV1(
        await root.desktopCommands.invoke(MACHINE_AGENT_STATUS_COMMAND_V1, {}),
      ),
    ).toMatchObject({ enrolled: false, running: false, failures: 0 });
    await root.fiber.dispose();
  });
});

describe("what this agent claims it can do (register row 57g)", () => {
  test("messages is claimed only by a Mac with handlers behind it", () => {
    expect(machineDesktopCapabilitiesV1("macos", true)).toEqual([
      "exec",
      "files",
      "messages",
    ]);
    // A Mac whose shell wired none: claiming it would mean every Messages
    // command reaching an agent that can only refuse.
    expect(machineDesktopCapabilitiesV1("macos", false)).toEqual([
      "exec",
      "files",
    ]);
    // Not a Mac. The enrollment decoder refuses the claim anyway; this is the
    // same fact on the agent's own side of the wire.
    for (const platform of ["windows", "linux"] as const) {
      expect(machineDesktopCapabilitiesV1(platform, true)).toEqual([
        "exec",
        "files",
      ]);
    }
  });
});
