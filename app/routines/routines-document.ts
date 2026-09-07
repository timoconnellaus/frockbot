// The `RoutinesFrame` a Bot's Routines route produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/settings/settings-document.ts`, reached with `?as=document`.
//
// The frame is the two reads the Vue section made separately: the Routines a
// Bot holds, and the completion inbox the header badge counts. They are one
// document because they are one surface, and because a client that had to ask
// twice could show a Routine list and a badge that disagreed.
//
// Every action declares a `kind` from the closed vocabulary below, because an
// action id is opaque to the renderer and the command a press means is not
// derivable from the label a person reads. Three kinds are Routine commands
// the route already takes, one is the inbox command, and the fifth is
// navigation — which no route owns.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type { RoutineInboxEntryViewV1, RoutineViewV1 } from "./shared.js";

export const ROUTINE_ACTION_KINDS_V1 = [
  "set-routine-enabled",
  "run-routine",
  "delete-routine",
  "acknowledge-inbox",
  "open-runs",
] as const;

export type RoutineActionKindV1 = (typeof ROUTINE_ACTION_KINDS_V1)[number];

/**
 * One Bot's Routines and its completion inbox, as the surface reads them.
 *
 * There is no shared revision counter to carry: a Routine is its own durable
 * record rather than a field of a settings view, which is why the commands
 * take no `expectedRevision`. The projection derives one from the frame's own
 * bytes instead, so the host adopts a fresh controller exactly when something
 * it is showing has changed and keeps the one it has when nothing did.
 */
export interface RoutinesFrameV1 {
  schemaVersion: 1;
  botId: string;
  routines: RoutineViewV1[];
  inbox: RoutineInboxEntryViewV1[];
  unacknowledged: number;
}

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
/** Inbox entries one document carries; the rest are read after acknowledging. */
const INBOX_LIMIT = 20;

const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const KIND: ActionValueSchema = {
  type: "string",
  enum: [...ROUTINE_ACTION_KINDS_V1],
};

/**
 * A durable moment in the house order — "4 Sep 2026, 9:00am" — read in the
 * zone it belongs to. A schedule is meant in the day the person who wrote it
 * is living in, so a Routine's own zone is the one its firings are read in.
 */
export function routineMomentV1(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  let parts;
  try {
    // The zone is the platform's; the words are ours. `month: "short"` is the
    // runtime's ICU talking — Node says "Sep" and workerd says "Sept" for the
    // same instant — and a date that changes shape with the runtime is not a
    // house order.
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(at);
  } catch {
    // A zone the platform does not know is still a moment: read it in UTC
    // rather than showing the wire.
    return routineMomentV1(iso, "UTC");
  }
  // A numeric month makes en-GB pad the day too, so the parts are read as
  // numbers rather than as whatever width the locale chose for them.
  const of = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const number = (type: string) => String(Number(of(type)));
  return `${number("day")} ${MONTHS[Number(of("month")) - 1] ?? ""} ${of(
    "year",
  )}, ${number("hour")}:${of("minute")}${of("dayPeriod")
    .toLowerCase()
    .replace(/\s/gu, "")}`;
}

/** The house order's own month names, so no runtime's ICU decides them. */
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * A revision derived from what the document says.
 *
 * FNV-1a over the projected text, so an unchanged frame keeps its number and
 * any change moves it. It is a change signal and nothing more: no command
 * fences on it.
 */
export function routinesRevisionV1(frame: RoutinesFrameV1): number {
  const text = JSON.stringify([
    frame.botId,
    frame.unacknowledged,
    frame.routines.map((routine) => [
      routine.routineId,
      routine.name,
      routine.prompt,
      routine.schedule,
      routine.timezone,
      routine.enabled,
      routine.lastRunAt,
      routine.nextRunAt,
      routine.updatedAt,
    ]),
    frame.inbox.map((entry) => [
      entry.entryId,
      entry.acknowledged,
      entry.repeatCount,
    ]),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
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

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

/** What a Routine fires on, and when it last did and next will. */
function routineFacts(routine: RoutineViewV1): string {
  const timing = routine.schedule
    ? `${routine.schedule} · ${routine.timezone}`
    : "Webhook trigger";
  const last = routine.lastRunAt
    ? `Last ${routineMomentV1(routine.lastRunAt, routine.timezone)}`
    : "Never run";
  // Absent is the authority saying it has armed no alarm — a paused Routine,
  // or a webhook one — so the line says that rather than inventing a moment.
  const next = routine.nextRunAt
    ? `Next ${routineMomentV1(routine.nextRunAt, routine.timezone)}`
    : routine.enabled
      ? "No next firing scheduled"
      : "Paused";
  return `${timing} · ${last} · ${next}`;
}

function routineNode(routine: RoutineViewV1): ViewNode {
  const id = routine.routineId;
  return {
    type: "group",
    orientation: "column",
    title: routine.name,
    children: [
      status(routineFacts(routine)),
      { type: "text", text: routine.prompt.slice(0, 4000) },
      {
        type: "group",
        orientation: "row",
        children: [
          press("set-routine-enabled", routine.enabled ? "Pause" : "Resume", {
            kind: "set-routine-enabled",
            routineId: id,
            enabled: !routine.enabled,
          }),
          press("run-routine", "Run now", {
            kind: "run-routine",
            routineId: id,
          }),
          press("open-runs", "Run log", { kind: "open-runs", routineId: id }),
          press(
            "delete-routine",
            "Delete",
            { kind: "delete-routine", routineId: id },
            "danger",
          ),
        ],
      },
    ],
  };
}

function inboxNode(entry: RoutineInboxEntryViewV1): ViewNode {
  const repeats = (entry.repeatCount ?? 1) > 1;
  return {
    type: "group",
    orientation: "column",
    children: [
      status(
        `${entry.attribution}${entry.failure ? " · Didn’t work" : ""}${
          repeats ? ` · Happened ${entry.repeatCount} times` : ""
        }`,
      ),
      { type: "text", text: entry.text.slice(0, 4000) },
      ...(entry.acknowledged
        ? []
        : [
            press("acknowledge-inbox", "Mark read", {
              kind: "acknowledge-inbox",
              entryId: entry.entryId,
            }),
          ]),
    ],
  };
}

/** A `RoutinesFrame` as a `ViewDocument`. */
export function routinesDocumentV1(frame: RoutinesFrameV1): ViewDocument {
  const unread = frame.unacknowledged;
  const children: ViewNode[] = [
    status(
      `${frame.routines.length} ${
        frame.routines.length === 1 ? "Routine" : "Routines"
      }${unread > 0 ? ` · ${unread > 99 ? "99+" : unread} unread` : ""}`,
    ),
  ];
  // The root and the count above, plus what the tail always costs: the empty
  // or overflow line, the inbox's own group, its empty line and "Mark all
  // read". Reserved up front so the last Routine admitted cannot be the reason
  // the inbox does not fit.
  let nodes = 7;
  let complete = true;
  // The Routine's own group, its two lines, the controls' row and the four
  // controls in it.
  const routineCost = 8;
  for (const routine of frame.routines) {
    if (nodes + routineCost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += routineCost;
    children.push(routineNode(routine));
  }
  if (frame.routines.length === 0) {
    children.push({
      type: "text",
      text: "No Routines yet. A Routine runs this Bot on a schedule, or when something calls its webhook.",
    });
  }
  if (!complete) {
    children.push(
      status(
        "The rest of this Bot's Routines need a newer app. Everything above is still yours to change.",
      ),
    );
  }

  const shown = frame.inbox.slice(0, INBOX_LIMIT);
  const inbox: ViewNode[] = [];
  if (shown.length === 0) {
    inbox.push(
      status("Nothing here yet. Finished Routines leave their results here."),
    );
  }
  for (const entry of shown) {
    const cost = entry.acknowledged ? 3 : 4;
    if (nodes + cost > NODE_LIMIT) break;
    nodes += cost;
    inbox.push(inboxNode(entry));
  }
  // "Mark all read" means what is on this document, not every unread entry the
  // object holds: with a Routine firing every minute, acknowledging everything
  // marks a completion read that nobody has seen.
  if (shown.some((entry) => !entry.acknowledged)) {
    inbox.push(
      press("acknowledge-inbox", "Mark all read", {
        kind: "acknowledge-inbox",
      }),
    );
  }
  children.push({
    type: "group",
    orientation: "column",
    title: "Routine completions",
    children: inbox,
  });

  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "routines",
    revision: routinesRevisionV1(frame),
    root: { type: "group", orientation: "column", children },
    actions: [
      {
        id: "set-routine-enabled",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            routineId: IDENTIFIER,
            enabled: { type: "boolean" },
          },
          required: ["kind", "routineId", "enabled"],
          additionalProperties: false,
        },
      },
      {
        id: "run-routine",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
      {
        id: "delete-routine",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
      {
        id: "open-runs",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
      {
        // `entryId` is optional, and its absence is what "Mark all read"
        // means: the host acknowledges the entries this document carried,
        // which is what the reader could see.
        id: "acknowledge-inbox",
        schema: {
          type: "object",
          properties: { kind: KIND, entryId: IDENTIFIER },
          required: ["kind"],
          additionalProperties: false,
        },
      },
    ],
  });
}
