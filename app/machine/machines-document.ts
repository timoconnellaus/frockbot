// The registry a `MachineListView` already produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/routines/routines-document.ts`, reached with `?as=document`.
//
// One command and nothing else: revoke a machine. It takes no revision — a
// machine is its own durable record, and the registry is eight of them — so,
// as with Routines, the projection derives a revision from its own bytes and
// no command fences on it.
//
// Nothing here adds a machine. A computer enrols itself when the person signs
// in to the FrockBot desktop app on it and runs its modules; the app asks for
// the one-time code under its own session and hands it to its own agent, so no
// code is ever shown to a person.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type {
  MachineListEntryV1,
  MachineListViewV1,
} from "@frockbot/core/machine-protocol";
import { agoV1 } from "@frockbot/app/shell/moment";

export const MACHINE_ACTION_KINDS_V1 = ["revoke-machine"] as const;

export type MachineActionKindV1 = (typeof MACHINE_ACTION_KINDS_V1)[number];

const KIND: ActionValueSchema = {
  type: "string",
  enum: [...MACHINE_ACTION_KINDS_V1],
};
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 200 };

/** A revision derived from what the document says — FNV-1a over its text. */
export function machinesRevisionV1(view: MachineListViewV1): number {
  const text = JSON.stringify(
    view.machines.map((machine) => [
      machine.machineId,
      machine.label,
      machine.platform,
      machine.capabilities,
      machine.connected,
      machine.lastSeenAt,
      machine.revokedAt ?? "",
    ]),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * What a machine can be asked to do, in the words a person approving it reads.
 *
 * The agent reports these when it enrolls, and the backend refuses an
 * operation a machine did not report, so the line is a fact about the machine
 * rather than a promise about the app.
 */
const CAPABILITY_WORDS: Record<string, string> = {
  exec: "run commands",
  files: "read and write files",
};

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

/** A machine's own line: where it is, what it can do, and whether it is there. */
function machineFacts(machine: MachineListEntryV1, now: string): string {
  const can = machine.capabilities
    .map((capability) => CAPABILITY_WORDS[capability] ?? capability)
    .join(", ");
  // Revoked outranks connected: a revoked machine's next connect is a 401, so
  // saying it is connected would be saying it still works. A connected machine
  // was seen a moment ago by definition, so when is only worth saying about
  // one that is not there.
  const state = machine.revokedAt
    ? `Revoked ${agoV1(machine.revokedAt, now)}`
    : machine.connected
      ? "Connected"
      : `Offline · last seen ${agoV1(machine.lastSeenAt, now)}`;
  return `${machine.platform} · ${can || "runs device modules"} · ${state}`;
}

function machineNode(
  machine: MachineListEntryV1,
  now: string,
  productName: string,
): ViewNode {
  return {
    type: "group",
    orientation: "column",
    title: machine.label,
    children: [
      status(machineFacts(machine, now)),
      ...(machine.revokedAt
        ? [
            status(
              `This computer’s key is retired. To connect it again, choose Run modules on this Mac in the ${productName} desktop app on it.`,
            ),
          ]
        : [
            {
              type: "action" as const,
              actionId: "revoke-machine",
              label: "Revoke",
              style: "danger" as const,
              input: {
                kind: "revoke-machine",
                machineId: machine.machineId,
              },
            },
          ]),
    ],
  };
}

/** A `MachineListView` as a `ViewDocument`. */
export function machinesDocumentV1(
  view: MachineListViewV1,
  productName: string,
): ViewDocument {
  const live = view.machines.filter((machine) => !machine.revokedAt);
  const connected = live.filter((machine) => machine.connected).length;
  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "machines",
    revision: machinesRevisionV1(view),
    root: {
      type: "group",
      orientation: "column",
      children: [
        {
          type: "text",
          text: `Your computers are Macs signed in to the ${productName} desktop app. Each is separate from your Bot’s hosted Computer. A Mac connects itself when you sign in to the app on it, and runs your Plugins’ device modules while the app is open. Revoke one here to cut it off.`,
        },
        // The count is the summary that sits under the title.
        // With nothing registered there is nothing to summarise, and the list
        // below already says so once.
        ...(view.machines.length === 0
          ? []
          : [status(`${live.length} registered · ${connected} connected`)]),
        ...(view.machines.length === 0
          ? [status("No computers are connected yet.")]
          : view.machines.map((machine) =>
              machineNode(machine, view.serverTime, productName),
            )),
      ],
    },
    actions: [
      {
        id: "revoke-machine",
        schema: {
          type: "object",
          properties: { kind: KIND, machineId: IDENTIFIER },
          required: ["kind", "machineId"],
          additionalProperties: false,
        },
      },
    ],
  });
}
