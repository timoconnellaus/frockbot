// The `RoutinesFrame` a Bot's Routines route produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/settings/settings-document.ts`, reached with `?as=document`.
//
// The frame is two reads in one: the Routines a Bot holds, and the completions
// each Routine left. They are one document because they are one surface, and
// because a client that had to ask twice could nest a run under the wrong
// Routine.
//
// Conversation authors a Routine. The list is what is armed; a named Routine
// is a read-only detail. There is no form.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type { RoutineInboxEntryViewV1, RoutineViewV1 } from "./shared.js";
import {
  routineTriggerLabelV1,
  routineTriggerNeedsHookKeyV1,
} from "./records.js";
import { describeRoutineScheduleV1 } from "./cron.js";

export const ROUTINE_ACTION_KINDS_V1 = [
  "set-routine-enabled",
  "run-routine",
  "delete-routine",
  "open-run",
  "open-runs",
  "open-routine",
  "rotate-key",
  "revoke-key",
] as const;

export type RoutineActionKindV1 = (typeof ROUTINE_ACTION_KINDS_V1)[number];

/**
 * One Bot's Routines and the completions nested under each of them.
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
   * The Routine the reader asked to see. The detail is its own document —
   * the list a person came to read is not a form, and conversation is the
   * only author.
   *
   * Which Routine that is is navigation — the host asks for this document
   * rather than the list, naming it — so no route owns the choice.
   */
  viewing?: RoutineViewV1;
}

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
/** Completions one Routine carries on the list; the run log has the rest. */
const RUNS_PER_ROUTINE = 3;

const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
/** The field ids the detail uses. There is one Routine on screen, so no id. */
export const ROUTINE_DETAIL_FIELDS_V1 = {
  name: "routine.name",
  prompt: "routine.prompt",
  timing: "routine.timing",
  config: "routine.config",
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
    frame.viewing?.routineId ?? "",
    frame.routines.map((routine) => [
      routine.routineId,
      routine.name,
      routine.prompt,
      routine.schedule,
      routine.trigger,
      routine.timezone,
      routine.enabled,
      routine.lastRunAt,
      routine.nextRunAt,
      routine.updatedAt,
      routine.hookKeyVersion ?? 0,
    ]),
    frame.inbox.map((entry) => [
      entry.entryId,
      entry.routineId,
      entry.createdAt,
      entry.failure === true,
      entry.repeatCount ?? 1,
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

function field(id: string, label: string, value: string | null): ViewNode {
  return {
    type: "field",
    field: { id, label, kind: "text", value, editable: false },
  } as ViewNode;
}

/** What a Routine fires on, and when it last did and next will. */
function routineFacts(routine: RoutineViewV1): string {
  const timing = routine.schedule
    ? `${describeRoutineScheduleV1(routine.schedule)} · ${routine.timezone}`
    : routine.trigger
      ? routineTriggerLabelV1(routine.trigger)
      : "Webhook trigger";
  const last = routine.lastRunAt
    ? `Last ${routineMomentV1(routine.lastRunAt, routine.timezone)}`
    : "Never run";
  // Absent is the authority saying it has armed no alarm — a paused Routine,
  // or a triggered one — so the line says that rather than inventing a moment.
  const next = routine.nextRunAt
    ? `Next ${routineMomentV1(routine.nextRunAt, routine.timezone)}`
    : routine.enabled
      ? "No next firing scheduled"
      : "Paused";
  return `${timing} · ${last} · ${next}`;
}

function triggerConfigTextV1(
  config: { query: string } | undefined,
): string | undefined {
  if (!config) return undefined;
  return `query: ${config.query}`;
}

/**
 * One Routine, as a row: what it is called, what it fires on and when it last
 * did, the way in, and the switch that pauses it.
 *
 * Everything else a Routine can be asked — run it now, read its log, mint or
 * revoke its key, delete it — is on the detail the row opens. A row is a
 * place to see what is armed and to turn it off; six controls on each of them
 * was a list nobody could read.
 */
function routineNode(
  routine: RoutineViewV1,
  runs: RoutineInboxEntryViewV1[],
): ViewNode {
  const id = routine.routineId;
  return {
    type: "group",
    orientation: "column",
    title: routine.name,
    children: [
      status(routineFacts(routine)),
      {
        type: "group",
        orientation: "row",
        children: [
          press("open-routine", "Open", {
            kind: "open-routine",
            routineId: id,
          }),
          press("set-routine-enabled", routine.enabled ? "Pause" : "Resume", {
            kind: "set-routine-enabled",
            routineId: id,
            enabled: !routine.enabled,
          }),
        ],
      },
      ...runs.map(completionNode),
    ],
  };
}

/**
 * One Routine, as a read-only detail. Conversation is the only author, so
 * nothing here writes name, prompt, or trigger.
 */
function detailNode(routine: RoutineViewV1): ViewNode {
  const ids = ROUTINE_DETAIL_FIELDS_V1;
  const id = routine.routineId;
  const keyed =
    routine.trigger !== undefined &&
    routineTriggerNeedsHookKeyV1(routine.trigger);
  const config = triggerConfigTextV1(
    routine.trigger?.kind === "connection" ? routine.trigger.config : undefined,
  );
  return {
    type: "group",
    orientation: "column",
    children: [
      field(ids.name, "Name", routine.name),
      field(ids.prompt, "Instructions", routine.prompt),
      field(
        ids.timing,
        "Fires on",
        routine.schedule
          ? `${describeRoutineScheduleV1(routine.schedule)} · ${routine.timezone}`
          : routine.trigger
            ? routineTriggerLabelV1(routine.trigger)
            : "Webhook trigger",
      ),
      ...(config === undefined
        ? []
        : [field(ids.config, "Trigger config", config)]),
      status(routineFacts(routine)),
      {
        type: "group",
        orientation: "row",
        children: [
          press("run-routine", "Run now", {
            kind: "run-routine",
            routineId: id,
          }),
          press("open-runs", "Run log", { kind: "open-runs", routineId: id }),
          ...(keyed
            ? [
                press(
                  "rotate-key",
                  routine.hookKeyVersion == null ? "Mint key" : "Rotate key",
                  {
                    kind: "rotate-key",
                    routineId: id,
                  },
                ),
                ...(routine.hookKeyVersion == null
                  ? []
                  : [
                      press(
                        "revoke-key",
                        "Revoke key",
                        { kind: "revoke-key", routineId: id },
                        "danger",
                      ),
                    ]),
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

/**
 * One completion, as the Bot page says a firing: the name, when, and how it
 * ended. The host draws the same loose row it draws there. A press opens the
 * run log — a completion is not a thing to mark read.
 */
function completionNode(entry: RoutineInboxEntryViewV1): ViewNode {
  const prefix = "Automation: ";
  const name = entry.attribution.startsWith(prefix)
    ? entry.attribution.slice(prefix.length)
    : entry.attribution;
  return {
    type: "group",
    orientation: "column",
    title: name.length === 0 ? "Routine" : name,
    children: [
      { type: "text", text: entry.createdAt, style: "status" },
      { type: "text", text: entry.failure === true ? "failed" : "finished" },
      {
        type: "group",
        orientation: "row",
        children: [
          press("open-run", "Open", {
            kind: "open-run",
            routineId: entry.routineId,
            entryId: entry.entryId,
          }),
        ],
      },
    ],
  };
}

/** Completions filed under the Routine that left them, newest first. */
function runsByRoutineV1(
  inbox: RoutineInboxEntryViewV1[],
): Map<string, RoutineInboxEntryViewV1[]> {
  const byRoutine = new Map<string, RoutineInboxEntryViewV1[]>();
  for (const entry of inbox) {
    const held = byRoutine.get(entry.routineId) ?? [];
    if (held.length >= RUNS_PER_ROUTINE) continue;
    held.push(entry);
    byRoutine.set(entry.routineId, held);
  }
  return byRoutine;
}

/** The list half: what is armed, and what each Routine left behind. */
function listChildren(frame: RoutinesFrameV1): ViewNode[] {
  const children: ViewNode[] = [];
  // The root, the two section groups, and the overflow line. Completions sit
  // inside the Routine that left them, so they are reserved per Routine.
  let nodes = 8;
  let complete = true;
  // The Routine's own group, its line, the controls' row and the two
  // controls in it. Each completion is a group, the stamp, the mark and the
  // press that opens it.
  const routineCost = 5;
  const runCost = 5;
  const runs = runsByRoutineV1(frame.inbox);
  const scheduled: ViewNode[] = [];
  const triggered: ViewNode[] = [];
  for (const routine of frame.routines) {
    const shown = runs.get(routine.routineId) ?? [];
    const cost = routineCost + runCost * shown.length;
    if (nodes + cost > NODE_LIMIT) {
      complete = false;
      break;
    }
    nodes += cost;
    (routine.schedule === undefined ? triggered : scheduled).push(
      routineNode(routine, shown),
    );
  }
  // A section is drawn only where it holds something: an empty "Triggered"
  // label over nothing is a heading for a thing that does not exist.
  if (scheduled.length > 0) {
    children.push({
      type: "group",
      orientation: "column",
      title: "Scheduled",
      children: scheduled,
    });
  }
  if (triggered.length > 0) {
    children.push({
      type: "group",
      orientation: "column",
      title: "Triggered",
      children: triggered,
    });
  }
  const known = new Set(frame.routines.map((routine) => routine.routineId));
  const past = frame.inbox
    .filter((entry) => !known.has(entry.routineId))
    .slice(0, RUNS_PER_ROUTINE);
  if (past.length > 0) {
    const cost = 1 + 5 * past.length;
    if (nodes + cost <= NODE_LIMIT) {
      nodes += cost;
      children.push({
        type: "group",
        orientation: "column",
        title: "Past",
        children: past.map(completionNode),
      });
    }
  }
  if (frame.routines.length === 0 && past.length === 0) {
    // A named thing with a line under it, so the empty surface is the same
    // card grammar as the full one rather than a sentence loose on the page.
    children.push({
      type: "group",
      orientation: "column",
      title: "No Routines yet",
      children: [
        {
          type: "text",
          text: "Ask this Bot to set up a Routine.",
        },
      ],
    });
  }
  if (!complete) {
    children.push(
      status(
        "The rest of this Bot's Routines need a newer app. Everything above is still yours to change.",
      ),
    );
  }
  return children;
}

/** A `RoutinesFrame` as a `ViewDocument`. */
export function routinesDocumentV1(frame: RoutinesFrameV1): ViewDocument {
  const children =
    frame.viewing !== undefined
      ? [detailNode(frame.viewing)]
      : listChildren(frame);
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
        // Navigation: the host opens the run log for the Routine this
        // completion belongs to. No route owns which firing is on screen.
        id: "open-run",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            routineId: IDENTIFIER,
            entryId: IDENTIFIER,
          },
          required: ["kind", "routineId", "entryId"],
          additionalProperties: false,
        },
      },
      {
        // Navigation: the host reads the document again, naming the Routine
        // whose detail is on screen. No route owns which one is open.
        id: "open-routine",
        schema: {
          type: "object",
          properties: { kind: KIND, routineId: IDENTIFIER },
          required: ["kind", "routineId"],
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
