// The registry a `MachineListView` already produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/routines/routines-document.ts`, reached with `?as=document`.
//
// Two commands and nothing else: register a machine, and revoke one. Neither
// takes a revision — a machine is its own durable record, and the registry is
// eight of them — so, as with Routines, the projection derives a revision from
// its own bytes and no command fences on it.
//
// The pairing code the register command mints is deliberately not here. It is
// signed once, stored only as a digest, and answered on the receipt: a
// document can be read twice, so a value that exists once cannot be in one.
// The host holds it for as long as the person is looking at it.

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

export const MACHINE_ACTION_KINDS_V1 = [
  "pair-machine",
  "revoke-machine",
] as const;

export type MachineActionKindV1 = (typeof MACHINE_ACTION_KINDS_V1)[number];

/** The field the register form carries: what to call the machine. */
export const MACHINE_LABEL_FIELD_V1 = "machine.label";

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
  messages: "read Messages",
};

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

/** A machine's own line: where it is, what it can do, and whether it is there. */
function machineFacts(machine: MachineListEntryV1, now: string): string {
  const can = machine.capabilities
    .map((capability) => CAPABILITY_WORDS[capability] ?? capability)
    .join(", ");
  // Revoked outranks connected: a revoked machine's next poll is a 401, so
  // saying it is connected would be saying it still works. A connected machine
  // was seen a moment ago by definition, so when is only worth saying about
  // one that is not there.
  const state = machine.revokedAt
    ? `Revoked ${agoV1(machine.revokedAt, now)}`
    : machine.connected
      ? "Connected"
      : `Offline · last seen ${agoV1(machine.lastSeenAt, now)}`;
  return `${machine.platform} · ${can || "nothing yet"} · ${state}`;
}

function machineNode(machine: MachineListEntryV1, now: string): ViewNode {
  return {
    type: "group",
    orientation: "column",
    title: machine.label,
    children: [
      status(machineFacts(machine, now)),
      ...(machine.revokedAt
        ? [
            status(
              "This machine's key is retired. Pair it again from the FrockBot Mac app to bring it back.",
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
export function machinesDocumentV1(view: MachineListViewV1): ViewDocument {
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
          text: "Your computers are devices running the FrockBot desktop app. Each is separate from your Bot’s hosted Computer. A Bot can read its files and run commands on it only while that app is open, and only after you approve each action.",
        },
        {
          type: "text",
          text: "Download FrockBot for Mac from frockbot.com. The Mac app is distributed directly, outside the Mac App Store. It connects Messages on your Mac while open. Your phone and web app control the connection remotely; they do not read the Mac’s Messages database. Requested message content is shared with FrockBot and your Bots’ AI providers only after you enable Messages sharing. Each send requires your approval.",
        },
        // The count is the summary that sits under the title.
        // With nothing registered there is nothing to summarise, and the list
        // below already says so once.
        ...(view.machines.length === 0
          ? []
          : [status(`${live.length} registered · ${connected} connected`)]),
        {
          type: "group",
          orientation: "column",
          title: "Connect a computer",
          collapsed: view.machines.length > 0,
          children: [
            {
              type: "field",
              field: {
                id: MACHINE_LABEL_FIELD_V1,
                label: "Name",
                kind: "text",
                value: null,
                editable: true,
                maxLength: 200,
                hint: "What to call this computer. Optional.",
              },
            },
            status(
              "You get a code here, once, and paste it into the FrockBot Mac app on the machine you want to register.",
            ),
            {
              type: "action",
              actionId: "pair-machine",
              label: "Get a pairing code",
              style: "primary",
              input: { kind: "pair-machine" },
            },
          ],
        },
        ...(view.machines.length === 0
          ? [status("No computers are connected yet.")]
          : view.machines.map((machine) =>
              machineNode(machine, view.serverTime),
            )),
      ],
    },
    actions: [
      {
        // `label` is optional: the enrolling agent sends its own name, and the
        // one typed here is only what to call it before it has arrived.
        id: "pair-machine",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            [MACHINE_LABEL_FIELD_V1]: { type: "string", maxLength: 200 },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
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
