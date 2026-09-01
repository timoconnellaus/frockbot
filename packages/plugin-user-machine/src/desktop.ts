// The registered machine's device agent, as a `trusted-main` Contribution.
//
// The plan's open decision 6: the device agent is the FrockBot desktop app
// itself. It needs no new binary, no notarization and no installer, and it
// matches the register's own evidence that "registered machines" is a section
// of GrokBot's desktop Settings. `connected` reports exactly what is true —
// the app is running.
//
// This file is the wiring and nothing else. It imports no `electron` and no
// `node:*`, because the house rule is that Electron authority lives in one
// file in `apps/desktop` and reaches Packages as a cordis capability. What it
// does is:
//
//   * build `MachineDeviceAgentV1` (the loop, in `./device.ts`) over the
//     `desktopMachineHost` and `desktopSecretStore` capabilities,
//   * register three desktop commands so the renderer can pair, unpair and
//     read status, and
//   * start the loop, and stop it on disposal.
//
// Everything decidable is in `./device.ts` and `./device-runner.ts`, both of
// which run under `bun test` with no Electron at all.

import type { DesktopCommand } from "@frockbot/desktop-core";
import {
  MACHINE_LIMITS_V1,
  type MachineCapabilityV1,
  type MachinePlatformV1,
} from "@frockbot/machine-protocol";
import type { Plugin } from "cordis";
import {
  createMachineDeviceRunnerV1,
  type MachineMessagesOpRunnerV1,
} from "./device-runner.js";
import {
  MachineDeviceAgentV1,
  type MachineDeviceAgentStatusV1,
  type MachineSecretStoreV1,
} from "./device.js";

/** The key the machine token rests under in the OS secure store. */
export const MACHINE_TOKEN_SECRET_KEY_V1 = "frockbot.machine-token";

export const MACHINE_AGENT_STATUS_COMMAND_V1 = "machine.agent.status";
export const MACHINE_AGENT_PAIR_COMMAND_V1 = "machine.agent.pair";
export const MACHINE_AGENT_UNPAIR_COMMAND_V1 = "machine.agent.unpair";

export interface MachineDesktopConfigV1 {
  /** The deployment this laptop dials. Never a path — an origin. */
  origin: string;
  /** What the agent reports as its own version at enrollment. */
  agentVersion: string;
  /** Injected in tests; the platform's `fetch` otherwise. */
  fetch?(input: string, init?: RequestInit): Promise<Response>;
  /**
   * Row 57g's Messages handlers, supplied by the Electron shell on macOS.
   *
   * Absent — every other platform, and a macOS build whose shell wired none —
   * and this agent does not report the `messages` capability at all, so the
   * backend never registers a Messages tool against it. Two halves of one gate:
   * the enrollment decoder refuses `messages` from a non-macOS agent, and this
   * refuses to claim it without something behind it.
   */
  messages?: MachineMessagesOpRunnerV1;
  /** Started on mount unless a test wants to drive cycles by hand. */
  autoStart?: boolean;
}

export interface MachinePairCommandInputV1 {
  code: string;
}

export function decodeMachinePairCommandInputV1(
  input: unknown,
): MachinePairCommandInputV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("machine pairing input must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "code") {
    throw new Error("machine pairing input takes only a code");
  }
  const code = typeof value.code === "string" ? value.code.trim() : "";
  if (!code || code.length > MACHINE_LIMITS_V1.pairingCode) {
    throw new Error("machine pairing code is required");
  }
  return { code };
}

/** The two commands with no input at all take no input at all. */
export function decodeMachineEmptyCommandInputV1(
  input: unknown,
): Record<string, never> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length > 0
  ) {
    throw new Error("this machine agent command takes no input");
  }
  return {};
}

/**
 * The secret store, narrowed to one key.
 *
 * The capability is a general key-value store because the shell may hold other
 * secrets later; the agent should not be able to read them, so it is handed a
 * closure over its own key and nothing else.
 */
export function machineSecretStoreV1(
  store: {
    read(key: string): Promise<string | undefined>;
    write(key: string, value: string): Promise<void>;
    clear(key: string): Promise<void>;
  },
  key: string = MACHINE_TOKEN_SECRET_KEY_V1,
): MachineSecretStoreV1 {
  return {
    read: () => store.read(key),
    write: (value) => store.write(key, value),
    clear: () => store.clear(key),
  };
}

/**
 * What this agent reports it can do on every platform the shell runs on.
 */
export const MACHINE_DESKTOP_CAPABILITIES_V1: readonly MachineCapabilityV1[] = [
  "exec",
  "files",
];

/**
 * What this agent reports, given its platform and what the shell wired.
 *
 * Row 57g's second gate, and it is deliberately conjunctive: `messages` is
 * claimed only by a macOS agent that actually has handlers behind it. Pure, so
 * the gate is asserted rather than inferred from a running Electron app.
 */
export function machineDesktopCapabilitiesV1(
  platform: MachinePlatformV1,
  messages: boolean,
): MachineCapabilityV1[] {
  return [
    ...MACHINE_DESKTOP_CAPABILITIES_V1,
    ...(platform === "macos" && messages
      ? (["messages"] as MachineCapabilityV1[])
      : []),
  ];
}

export const machineDesktopPlugin: Plugin.Function<MachineDesktopConfigV1> = (
  ctx,
  config,
) => {
  const identity = ctx.desktopMachineHost.identity();
  const capabilities = machineDesktopCapabilitiesV1(
    identity.platform,
    config.messages !== undefined,
  );
  const agent = new MachineDeviceAgentV1({
    origin: config.origin,
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    secrets: machineSecretStoreV1(ctx.desktopSecretStore),
    runner: createMachineDeviceRunnerV1({
      host: ctx.desktopMachineHost,
      capabilities,
      ...(config.messages === undefined ? {} : { messages: config.messages }),
    }),
    label: identity.label,
    platform: identity.platform,
    agentVersion: config.agentVersion,
    capabilities,
  });

  const status: DesktopCommand<
    Record<string, never>,
    MachineDeviceAgentStatusV1
  > = {
    id: MACHINE_AGENT_STATUS_COMMAND_V1,
    decode: decodeMachineEmptyCommandInputV1,
    execute: async () => {
      await agent.paired();
      return agent.status();
    },
  };

  const pair: DesktopCommand<
    MachinePairCommandInputV1,
    MachineDeviceAgentStatusV1
  > = {
    id: MACHINE_AGENT_PAIR_COMMAND_V1,
    decode: decodeMachinePairCommandInputV1,
    execute: async (input) => {
      const paired = await agent.pair(input.code);
      // The loop is what makes the machine read `connected`, so pairing starts
      // it rather than waiting for the next launch.
      agent.start();
      return paired;
    },
  };

  const unpair: DesktopCommand<
    Record<string, never>,
    MachineDeviceAgentStatusV1
  > = {
    id: MACHINE_AGENT_UNPAIR_COMMAND_V1,
    decode: decodeMachineEmptyCommandInputV1,
    execute: () => agent.unpair(),
  };

  const registrations = [
    ctx.desktopCommands.register(status),
    ctx.desktopCommands.register(pair),
    ctx.desktopCommands.register(unpair),
  ];

  if (config.autoStart !== false) {
    // Only if this laptop already holds a token: an unpaired agent has nothing
    // to poll, and the loop would otherwise idle against a door it has no key
    // to.
    void agent.paired().then((paired) => {
      if (paired) agent.start();
    });
  }

  return [...registrations, () => void agent.stop()];
};

machineDesktopPlugin.inject = [
  "desktopCommands",
  "desktopMachineHost",
  "desktopSecretStore",
];

export default machineDesktopPlugin;
