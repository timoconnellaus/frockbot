// The `AuditFrame` the audit route produces, projected as the `ViewDocument`
// the host renders — the same convention as `app/settings/settings-document.ts`
// and `app/routines/routines-document.ts`, reached with `?as=document`.
//
// The projection infers nothing. An effect whose outcome the durable event log
// cannot explain is drawn as "Outcome unknown" in the same place a success or
// a failure would be, and a table trimmed to its retention bound says so above
// the rows rather than quietly answering with less than it holds.
//
// Every action declares a `kind` from the closed vocabulary below. Two are the
// reader's own query — which the host owns, because the host owns the read —
// one is the rebuild command, and one opens a run in the Work view.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { MONTHS } from "@frockbot/app/routines/routines-document";
import {
  AUDIT_KINDS_V1,
  AUDIT_TARGET_COMPUTER_V1,
  AUDIT_TARGET_MACHINE_PREFIX_V1,
  AUDIT_TARGET_REMOTE_PREFIX_V1,
  AUDIT_TARGET_WORKSPACE_V1,
  type AuditEntryV1,
  type AuditIndexStateV1,
  type AuditKindV1,
} from "./shared.js";

export const AUDIT_ACTION_KINDS_V1 = [
  "filter-kind",
  "load-more",
  "rebuild",
  "open-run",
] as const;

export type AuditActionKindV1 = (typeof AUDIT_ACTION_KINDS_V1)[number];

/** One page of one Bot's audited effects, as the surface reads them. */
export interface AuditFrameV1 {
  schemaVersion: 1;
  botId: string;
  entries: AuditEntryV1[];
  /** How many entries match the filters, before paging. */
  total: number;
  indexState: AuditIndexStateV1;
  /** The kind the reader is filtered to, or nothing for every kind. */
  kind?: AuditKindV1;
  nextCursor?: string;
}

const NODE_LIMIT = 512;
const KIND_LABELS: Record<AuditKindV1, string> = {
  shell: "Commands",
  browser: "Browser",
  mcp: "Connected services",
  file: "Files",
  process: "Processes",
};
const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const KIND: ActionValueSchema = {
  type: "string",
  enum: [...AUDIT_ACTION_KINDS_V1],
};

const OUTCOMES: Record<AuditEntryV1["outcome"], string> = {
  ok: "Completed",
  error: "Failed",
  refused: "Refused",
  interrupted: "Interrupted",
  unknown: "Outcome unknown",
};

/** Where the effect ran, in words rather than in the wire shape. */
export function auditTargetLabelV1(target: string): string {
  if (target === AUDIT_TARGET_COMPUTER_V1) return "Hosted Computer";
  // Memory and Skills are files in the Workspace, not on the Computer.
  if (target === AUDIT_TARGET_WORKSPACE_V1) return "Workspace";
  if (target.startsWith(AUDIT_TARGET_MACHINE_PREFIX_V1)) {
    return `Machine ${target.slice(AUDIT_TARGET_MACHINE_PREFIX_V1.length)}`;
  }
  if (target.startsWith(AUDIT_TARGET_REMOTE_PREFIX_V1)) {
    return target.slice(AUDIT_TARGET_REMOTE_PREFIX_V1.length);
  }
  return target;
}

/**
 * The moment, in the house order, read in UTC — the zone the log is kept in.
 *
 * The month name is ours rather than the runtime's, for the reason
 * `routineMomentV1` gives: a date that changes shape between Node and workerd
 * is not a house order.
 */
export function auditMomentV1(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  // A numeric month makes en-GB pad the day too, so the parts are read as
  // numbers rather than as whatever width the locale chose for them.
  const of = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const number = (type: string) => String(Number(of(type)));
  return `${number("day")} ${MONTHS[Number(of("month")) - 1] ?? ""} ${of(
    "year",
  )}, ${number("hour")}:${of("minute")}${of("dayPeriod")
    .toLowerCase()
    .replace(/\s/gu, "")} UTC`;
}

/** A revision derived from what the document says; see `routinesRevisionV1`. */
export function auditRevisionV1(frame: AuditFrameV1): number {
  const text = JSON.stringify([
    frame.botId,
    frame.total,
    frame.indexState,
    frame.kind ?? "",
    frame.nextCursor ?? "",
    frame.entries.map((entry) => [
      entry.runId,
      entry.occurrenceId,
      entry.outcome,
    ]),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

function press(
  actionId: string,
  label: string,
  input: Record<string, string | boolean>,
  style?: "primary" | "danger",
): ViewNode {
  return {
    type: "action",
    actionId,
    label: label.slice(0, 100),
    ...(style ? { style } : {}),
    input,
  };
}

function entryNode(entry: AuditEntryV1, allBots: boolean): ViewNode {
  const facts = [
    ...(allBots ? [`Bot: ${entry.botId}`] : []),
    OUTCOMES[entry.outcome],
    entry.toolName,
    auditTargetLabelV1(entry.target),
    auditMomentV1(entry.at),
    ...(entry.durationMs === undefined ? [] : [`${entry.durationMs} ms`]),
  ].join(" · ");
  return {
    type: "group",
    orientation: "column",
    title: entry.preview.slice(0, 200) || entry.toolName,
    children: [
      status(facts),
      ...(entry.outcome === "unknown"
        ? [
            {
              type: "text" as const,
              text: "Its outcome is uncertain. Check the affected service before repeating the action.",
            },
          ]
        : []),
      press("open-run", "View activity details", {
        kind: "open-run",
        runId: entry.runId,
        botId: entry.botId,
      }),
    ],
  };
}

/** An `AuditFrame` as a `ViewDocument`. */
export function auditDocumentV1(frame: AuditFrameV1): ViewDocument {
  const children: ViewNode[] = [
    status(
      `${frame.total} audited ${frame.total === 1 ? "effect" : "effects"}${
        frame.kind ? ` · ${frame.kind}` : ""
      }`,
    ),
    {
      type: "text",
      text: `${frame.botId ? "This Bot" : "All your Bots"} · Recorded computer actions, connected service calls and file changes. Command details aren’t stored.`,
    },
    // One action per kind rather than a `list`: a `list` row carries no input,
    // so a row could not say which kind it means, and the whole of a filter is
    // its name plus whether it is the one in force.
    {
      type: "group",
      orientation: "row",
      children: [
        press(
          "filter-kind",
          "All",
          { kind: "filter-kind" },
          frame.kind === undefined ? "primary" : undefined,
        ),
        ...AUDIT_KINDS_V1.map((auditKind) =>
          press(
            "filter-kind",
            KIND_LABELS[auditKind],
            { kind: "filter-kind", auditKind },
            frame.kind === auditKind ? "primary" : undefined,
          ),
        ),
      ],
    },
  ];
  if (frame.indexState === "truncated") {
    children.push(
      status(
        "Older activity has been trimmed. Rebuild to restore what’s still available.",
      ),
    );
  } else if (frame.indexState === "rebuilding") {
    children.push(
      status("Rebuilding. What’s shown may be incomplete until it finishes."),
    );
  }

  // The root, the lines above and the tail the overflow and the page may need.
  let nodes = 12;
  let complete = true;
  for (const entry of frame.entries) {
    const cost = entry.outcome === "unknown" ? 5 : 4;
    if (nodes + cost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += cost;
    children.push(entryNode(entry, !frame.botId));
  }
  if (frame.entries.length === 0) {
    children.push({
      type: "text",
      text: "No recorded effects yet. Actions appear here as this Bot works.",
    });
  }
  if (frame.nextCursor && complete) {
    children.push(
      press("load-more", "Earlier activity", {
        kind: "load-more",
        cursor: frame.nextCursor,
      }),
    );
  }
  if (!complete) {
    children.push(
      status(
        "The rest of this page needs a newer app. Narrow the filter to see it.",
      ),
    );
  }
  children.push({
    type: "group",
    orientation: "column",
    title: "Advanced — repair history",
    collapsed: true,
    children: [
      status(
        "Rebuild the activity list from retained records if entries appear to be missing. This does not repeat any actions.",
      ),
      press("rebuild", "Rebuild history", { kind: "rebuild" }),
    ],
  });

  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "audit",
    revision: auditRevisionV1(frame),
    root: { type: "group", orientation: "column", children },
    actions: [
      {
        id: "filter-kind",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            auditKind: { type: "string", enum: [...AUDIT_KINDS_V1] },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      {
        id: "load-more",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            cursor: { type: "string", maxLength: 512 },
          },
          required: ["kind", "cursor"],
          additionalProperties: false,
        },
      },
      {
        id: "rebuild",
        schema: {
          type: "object",
          properties: { kind: KIND },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      {
        id: "open-run",
        schema: {
          type: "object",
          properties: { kind: KIND, runId: IDENTIFIER, botId: IDENTIFIER },
          required: ["kind", "runId", "botId"],
          additionalProperties: false,
        },
      },
    ],
  });
}
