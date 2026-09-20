// The `RoutinesFrame` a Bot's Routines route produces, projected as the
// `ViewDocument` the host renders — the same convention as
// `app/settings/settings-document.ts`, reached with `?as=document`.
//
// The frame is two reads in one: the Routines a Bot holds, and the completions
// each Routine left. They are one document because they are one surface, and
// because a client that had to ask twice could nest a run under the wrong
// Routine.
//
// Every action declares a `kind` from the closed vocabulary below, because an
// action id is opaque to the renderer and the command a press means is not
// derivable from the label a person reads. The Routine commands the route
// already takes, and the navigation no route owns.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import type { RoutineInboxEntryViewV1, RoutineViewV1 } from "./shared.js";
import { routineTriggerLabelV1 } from "./records.js";
import { describeRoutineScheduleV1 } from "./cron.js";

export const ROUTINE_ACTION_KINDS_V1 = [
  "set-routine-enabled",
  "run-routine",
  "delete-routine",
  "open-run",
  "open-runs",
  "edit-routine",
  "cancel-edit",
  "save-routine",
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
   * The Routine the reader asked to edit, if any. The editor is its own
   * document — a form per Routine would be a second copy of every prompt in
   * the list, and the list a person came to read is not a form.
   *
   * Which Routine that is is navigation — the host asks for this document
   * rather than the list, naming it — so no route owns the choice.
   */
  editing?: RoutineViewV1;
  /**
   * The reader asked for a new Routine. The document is that empty form, not
   * the list with a form on it.
   */
  creating?: true;
}

/** The renderer's node budget, checked before it builds a widget. */
const NODE_LIMIT = 512;
/** Completions one Routine carries on the list; the run log has the rest. */
const RUNS_PER_ROUTINE = 3;

const IDENTIFIER: ActionValueSchema = { type: "string", maxLength: 128 };
const TEXT = (maxLength: number): ActionValueSchema => ({
  type: "string",
  maxLength,
});
/** The field ids the editor's one form uses, and the action that reads them. */
export const ROUTINE_EDITOR_FIELDS_V1 = {
  editorId: "routine.editorId",
  name: "routine.name",
  prompt: "routine.prompt",
  /**
   * What starts the Routine, as the host answers it: `schedule`, `webhook`,
   * `plugin:<pluginId>:<trigger>`, or `connection:<connectionId>:<triggerType>`
   * — one value, because a Routine fires on exactly one of them.
   */
  timing: "routine.timing",
  schedule: "routine.schedule",
  scheduleDescription: "routine.scheduleDescription",
  timezone: "routine.timezone",
  keyVersion: "routine.keyVersion",
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
    // The editor's seeds are part of what the document says, so naming a
    // different Routine — or asking for a new one — moves the revision and
    // the host adopts a controller whose field values are answers to the
    // form now on screen.
    frame.creating === true,
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

/**
 * One Routine, as a row: what it is called, what it fires on and when it last
 * did, the way in, and the switch that pauses it.
 *
 * Everything else a Routine can be asked — run it now, read its log, mint or
 * revoke its key, delete it — is on the editor the row opens. A row is a
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
          press("edit-routine", "Edit", {
            kind: "edit-routine",
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
 * This is the whole document when it is shown. The list never carries it,
 * collapsed or otherwise — a surface someone came to read is not a form.
 */
function editorNode(frame: RoutinesFrameV1): ViewNode {
  const editing = frame.editing;
  const ids = ROUTINE_EDITOR_FIELDS_V1;
  const connection =
    editing?.trigger?.kind === "connection" ? editing.trigger : undefined;
  const plugin =
    editing?.trigger?.kind === "plugin" ? editing.trigger : undefined;
  const webhook = editing?.trigger?.kind === "webhook";
  const timing = connection
    ? `connection:${connection.connectionId}:${connection.triggerType}`
    : plugin
      ? `plugin:${plugin.pluginId}:${plugin.trigger}`
      : webhook
        ? "webhook"
        : "schedule";
  const schedule = editing?.schedule ?? "0 9 * * *";
  return {
    type: "group",
    orientation: "column",
    children: [
      field(ids.editorId, "Routine", editing?.routineId ?? null, {
        choiceSource: "routine-editor-hidden",
      }),
      field(ids.name, "Name", editing?.name ?? null, {
        maxLength: 100,
        required: true,
        choiceSource: "routine-editor-hidden",
      }),
      field(ids.prompt, "Prompt", editing?.prompt ?? null, {
        maxLength: 8000,
        hint: "What the Routine does when it fires.",
        choiceSource: "routine-editor-hidden",
      }),
      field(ids.schedule, "Schedule", schedule, {
        maxLength: 256,
        choiceSource: "routine-editor-hidden",
      }),
      field(
        ids.scheduleDescription,
        "Schedule description",
        describeRoutineScheduleV1(schedule),
        { choiceSource: "routine-editor-hidden" },
      ),
      field(ids.timezone, "Timezone", editing?.timezone ?? null, {
        choiceSource: "routine-editor-hidden",
      }),
      field(
        ids.keyVersion,
        "Webhook key version",
        editing?.hookKeyVersion == null ? null : String(editing.hookKeyVersion),
        { choiceSource: "routine-editor-hidden" },
      ),
      field(ids.timing, "Fires on", timing, {
        maxLength: 256,
        required: true,
        choiceSource: "routine-editor",
      }),
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
  // A section is drawn only where it holds something: an empty "Webhooks"
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
      title: "Webhooks",
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
          text: "A Routine runs this Bot on a schedule, or when something calls its webhook.",
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
    frame.creating === true || frame.editing !== undefined
      ? [editorNode(frame)]
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
        // update, and its absence is what "create" means. The four field ids
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
            [ROUTINE_EDITOR_FIELDS_V1.timing]: TEXT(256),
            [ROUTINE_EDITOR_FIELDS_V1.schedule]: TEXT(256),
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
