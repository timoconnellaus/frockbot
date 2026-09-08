// The `RoutinesFrame` a Bot's Routines route produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/settings/settings-document.ts`, reached with `?as=document`.
//
// The frame is two reads in one: the Routines a Bot holds, and the completion
// inbox the header badge counts. They are one
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
  "edit-routine",
  "cancel-edit",
  "save-routine",
  "rotate-key",
  "revoke-key",
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
  /**
   * The Routine the reader asked to edit, if any. There is one editor on the
   * surface, seeded from here, rather than a form per Routine: a form per
   * Routine would be a second copy of every prompt in the document and would
   * spend one of the thirty-two declared actions on each of them.
   *
   * Which Routine that is is navigation — the host asks for the document
   * again, naming it — so no route owns the choice.
   */
  editing?: RoutineViewV1;
}

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
/** Inbox entries one document carries; the rest are read after acknowledging. */
const INBOX_LIMIT = 20;

const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const TEXT = (maxLength: number): ActionValueSchema => ({
  type: "string",
  maxLength,
});
/** What a Routine fires on. Exactly one of the two, which the codec enforces. */
const TIMING: ActionValueSchema = {
  type: "string",
  enum: ["schedule", "webhook"],
};

/** The field ids the editor's one form uses, and the action that reads them. */
export const ROUTINE_EDITOR_FIELDS_V1 = {
  name: "routine.name",
  prompt: "routine.prompt",
  timing: "routine.timing",
  schedule: "routine.schedule",
  timezone: "routine.timezone",
} as const;
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
    // The editor's seeds are part of what the document says, so naming a
    // different Routine moves the revision and the host adopts a controller
    // whose field values are answers to the form now on screen.
    frame.editing?.routineId ?? "",
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
      routine.hookKeyVersion ?? 0,
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
  const webhook = routine.schedule === undefined;
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
          press("edit-routine", "Edit", {
            kind: "edit-routine",
            routineId: id,
          }),
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
          // A key belongs to a webhook Routine and to nothing else, and the
          // route refuses one for a scheduled Routine — so the controls are
          // absent rather than offered and then refused.
          ...(webhook
            ? [
                press(
                  "rotate-key",
                  routine.hookKeyVersion ? "Rotate key" : "Mint key",
                  { kind: "rotate-key", routineId: id },
                ),
              ]
            : []),
          ...(webhook && routine.hookKeyVersion
            ? [
                press(
                  "revoke-key",
                  "Revoke key",
                  { kind: "revoke-key", routineId: id },
                  "danger",
                ),
              ]
            : []),
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

function field(
  id: string,
  label: string,
  value: string | null,
  extra: Record<string, unknown> = {},
): ViewNode {
  return {
    type: "field",
    field: { id, label, kind: "text", value, editable: true, ...extra },
  } as ViewNode;
}

/**
 * The one editor: a new Routine, or the one the reader asked to edit.
 *
 * Collapsed when nothing is being edited, so a surface a person came to read
 * is not mostly a form. Expanded the moment a Routine is named, because being
 * named is what asked for it.
 */
function editorNode(frame: RoutinesFrameV1): ViewNode {
  const editing = frame.editing;
  const ids = ROUTINE_EDITOR_FIELDS_V1;
  const webhook = editing !== undefined && editing.schedule === undefined;
  // A schedule is meant in the day the person who wrote it is living in, and
  // this side of the wire cannot know that day: the phone has no IANA zone to
  // send. So a new Routine inherits the zone this Bot's Routines already use,
  // which is the closest thing to it that is actually known, and says so.
  const inherited = frame.routines.at(-1)?.timezone ?? "UTC";
  return {
    type: "group",
    orientation: "column",
    title: editing ? `Edit ${editing.name}` : "New Routine",
    collapsed: editing === undefined,
    children: [
      field(ids.name, "Name", editing?.name ?? null, {
        maxLength: 100,
        required: true,
      }),
      field(ids.prompt, "Prompt", editing?.prompt ?? null, {
        maxLength: 8000,
        hint: "What the Routine does when it fires.",
      }),
      {
        type: "field",
        field: {
          id: ids.timing,
          label: "Fires on",
          kind: "select",
          value: webhook ? "webhook" : "schedule",
          editable: true,
          choices: [
            { label: "A schedule", value: "schedule" },
            { label: "A webhook", value: "webhook" },
          ],
        },
      } as ViewNode,
      field(ids.schedule, "Schedule", editing?.schedule ?? "0 9 * * *", {
        maxLength: 256,
        hint: "cron, or @daily / @every 15m. Ignored for a webhook Routine, which is given a key instead.",
      }),
      field(ids.timezone, "Time zone", editing?.timezone ?? inherited, {
        maxLength: 64,
        hint: `The zone the schedule is read in, like Australia/Sydney.${
          editing ? "" : ` Starting from ${inherited}.`
        }`,
      }),
      {
        type: "group",
        orientation: "row",
        children: [
          press(
            "save-routine",
            editing ? "Save changes" : "Create Routine",
            editing
              ? { kind: "save-routine", routineId: editing.routineId }
              : { kind: "save-routine" },
            "primary",
          ),
          ...(editing
            ? [press("cancel-edit", "Cancel", { kind: "cancel-edit" })]
            : []),
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
  children.push(editorNode(frame));
  // The root and the count above, the editor's group with its five fields and
  // its two controls in their row, plus what the tail always costs: the empty
  // or overflow line, the inbox's own group, its empty line and "Mark all
  // read". Reserved up front so the last Routine admitted cannot be the reason
  // the editor or the inbox does not fit.
  let nodes = 16;
  let complete = true;
  // The Routine's own group, its two lines, the controls' row and the six
  // controls a webhook Routine puts in it.
  const routineCost = 10;
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
      {
        // Navigation: the host reads the document again, naming the Routine
        // whose values seed the editor. No route owns which form is open.
        id: "edit-routine",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
      {
        id: "cancel-edit",
        schema: {
          type: "object",
          properties: { kind: KIND },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      {
        // One action for both verbs: a `routineId` names the Routine to
        // update, and its absence is what "create" means. The five field ids
        // are declared here, which is what lets their current values travel
        // with the press and nothing else.
        id: "save-routine",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            routineId: IDENTIFIER,
            [ROUTINE_EDITOR_FIELDS_V1.name]: TEXT(100),
            [ROUTINE_EDITOR_FIELDS_V1.prompt]: TEXT(8000),
            [ROUTINE_EDITOR_FIELDS_V1.timing]: TIMING,
            [ROUTINE_EDITOR_FIELDS_V1.schedule]: TEXT(256),
            [ROUTINE_EDITOR_FIELDS_V1.timezone]: TEXT(64),
          },
          required: [
            "kind",
            ROUTINE_EDITOR_FIELDS_V1.name,
            ROUTINE_EDITOR_FIELDS_V1.prompt,
            ROUTINE_EDITOR_FIELDS_V1.timing,
          ],
          additionalProperties: false,
        },
      },
      {
        // The minted key comes back on the receipt and is never in a
        // document: it exists once, and a document can be read twice.
        id: "rotate-key",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
      {
        id: "revoke-key",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
          additionalProperties: false,
        },
      },
    ],
  });
}
