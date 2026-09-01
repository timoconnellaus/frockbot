// Row 57g's gate, as one pure function.
//
// The register gates the Messages tools twice — "behind a feature gate and a
// permission check" — and the transport adds a third that falls out of what a
// laptop is: the tools mean nothing without a connected Mac to run them on. So
// there are three independent answers, and they are deliberately different
// *kinds* of answer:
//
//  1. **The User setting** (`machines.messagesEnabled`, GrokBot's
//     `gates.messagesTools`). Off is the default, and off means the tools are
//     never registered — absent from the catalog rather than present and
//     refusing. A capability a Bot cannot see is one it cannot be talked into
//     trying.
//  2. **The device capability.** The agent reports `messages` at enrollment,
//     and only a `platform: "macos"` agent may: the protocol's own enrollment
//     decoder refuses it from anything else, and the desktop agent claims it
//     only when the shell wired handlers behind it. No connected macOS machine
//     reporting it ⇒ no registration.
//  3. **The OS permission** (`CheckIMessagePermissions`). Full Disk Access for
//     `chat.db` and Automation rights over Messages.app are the User's to grant
//     in System Settings; the backend can only ever *report* them. That gate is
//     per call rather than per catalog, because it can change between one Turn
//     and the next, and it lives in `./agent.ts` beside the call it refuses.
//
// This file holds the first two, which decide whether the tools exist at all.
// It is pure so the gate is asserted rather than inferred from a running app.
import type { MachineListEntryV1 } from "@frockbot/machine-protocol";

/** The Package setting id, as the manifest declares it. */
export const MACHINE_MESSAGES_SETTING_V1 = "messages-enabled";

/**
 * The setting's value, defaulting to **off**.
 *
 * A setting nobody has touched is off, and anything that is not `true` is off:
 * reaching into somebody's messages is not a thing to do on a value the
 * resolver could not make sense of.
 */
export function machineMessagesEnabledV1(
  values: Readonly<Record<string, string | number | boolean>> | undefined,
): boolean {
  return values?.[MACHINE_MESSAGES_SETTING_V1] === true;
}

export type MachineMessagesGateV1 =
  | { status: "off" }
  | { status: "no-machine" }
  | { status: "ready"; machineIds: string[] };

/** Whether one registry row can run a Messages call right now. */
export function machineMessagesCandidateV1(entry: MachineListEntryV1): boolean {
  return (
    entry.revokedAt === undefined &&
    entry.connected &&
    entry.platform === "macos" &&
    entry.capabilities.includes("messages")
  );
}

/**
 * Whether the Messages tools are registered for this Turn, and against which
 * machines.
 *
 * `machineIds` is a list rather than a single id because the tools take a
 * `machineId` like every other machine tool: the Bot chooses from
 * `machine_list`, and this is only the fact that at least one choice exists.
 */
export function machineMessagesGateV1(input: {
  enabled: boolean;
  machines: readonly MachineListEntryV1[];
}): MachineMessagesGateV1 {
  if (!input.enabled) return { status: "off" };
  const machineIds = input.machines
    .filter((entry) => machineMessagesCandidateV1(entry))
    .map((entry) => entry.machineId);
  return machineIds.length === 0
    ? { status: "no-machine" }
    : { status: "ready", machineIds };
}
