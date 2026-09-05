import {
  decodeConnectionTriggerV1,
  type ConnectionTriggerV1,
  type ConnectionTriggerCatalogV1,
} from "@frockbot/connection-core";
// The Routines runtime Contribution: one tool, `routine_manage`.
//
// GrokBot's `update_state target=routine {create,update,pause,resume,delete}`
// (docs/research/grokbot-computer.md, row 19) reaches FrockBot as a single tool
// that calls the same command path the hosted client calls. There is no second
// way to write a Routine, so a Bot editing its own Routine and a User editing it
// produce the same durable record with different recorded provenance.
//
// "Self-modification never widens authority": a Bot-authored Routine runs as the
// Bot, with the User's enabled Packages and Connections. Nothing here grants
// anything.
//
// `run_now` fires the Routine out of band. It enqueues rather than runs: the
// tool is called from inside an admitted Turn, and a Bot Durable Object holds
// exactly one run at a time, so the firing is durable immediately and lands the
// moment the calling Turn settles. "Queue, never drop, never parallel."
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
  RoutineDecodeError,
  type RoutineWriterV1,
} from "./records.js";
import {
  decodeRoutineCommandV1,
  type RoutineCommandReceiptV1,
  type RoutineCommandV1,
  type RoutineListViewV1,
} from "./shared.js";

/** The Session and Turn a Bot-authored Routine write records as its writer. */
export interface RoutineWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * The host seam this Package receives. The Durable Object supplies it for one
 * admitted Turn: without `writer` there is no Turn to attribute a write to, and
 * the tool is then not registered at all.
 */
export interface RoutinesRuntimeHostV1 {
  botId: string;
  writer?: RoutineWriterIdentityV1;
  list(): Promise<RoutineListViewV1>;
  listTriggers?(): Promise<ConnectionTriggerCatalogV1>;
  execute(
    command: RoutineCommandV1,
    writer: RoutineWriterV1,
  ): Promise<RoutineCommandReceiptV1>;
}

export const ROUTINE_MANAGE_ACTIONS = [
  "create",
  "update",
  "pause",
  "resume",
  "delete",
  "run_now",
  "list_triggers",
] as const;

export type RoutineManageActionV1 = (typeof ROUTINE_MANAGE_ACTIONS)[number];

const ROUTINE_MANAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ROUTINE_MANAGE_ACTIONS],
      description:
        "What to do with the Routine. run_now queues one firing immediately; it lands after the current Turn.",
    },
    routineId: {
      type: "string",
      description:
        "The Routine to act on. Required for every action except create.",
    },
    name: { type: "string", description: "The Routine's display name." },
    prompt: {
      type: "string",
      description: "The instruction the Routine runs when it fires.",
    },
    schedule: {
      type: "string",
      description:
        "A five-field cron expression, or @hourly, @daily, @weekly, @monthly, or @every 15m. Optionally prefixed with CRON_TZ=<zone>. A Routine has a schedule or a webhook trigger, never both.",
    },
    trigger: {
      oneOf: [
        { type: "string", enum: ["webhook"] },
        {
          type: "object",
          properties: {
            composio: {
              type: "object",
              properties: {
                connectionId: { type: "string" },
                triggerType: { type: "string" },
                config: { type: "object" },
              },
              required: ["connectionId", "triggerType", "config"],
              additionalProperties: false,
            },
          },
          required: ["composio"],
          additionalProperties: false,
        },
      ],
      description:
        "Fire on an event from an existing connected account. Use list_triggers first to find the account, event type and configuration schema. A Routine has a schedule or a trigger, never both.",
    },
    timezone: {
      type: "string",
      description:
        "IANA time zone the schedule is read in, such as Australia/Sydney.",
    },
    userAsked: {
      type: "boolean",
      description:
        "Set true only when the User asked you, in this conversation, to pause, edit, or delete this Routine. Required for those three actions on a Routine the User created. Never set it because a Routine looks wrong to you, is failing, or is no longer useful: say so and let the User decide.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

/** The actions that switch off or overwrite something already running. */
const DESTRUCTIVE_ROUTINE_ACTIONS = new Set<RoutineManageActionV1>([
  "pause",
  "update",
  "delete",
]);

interface RoutineManageInputV1 {
  action: RoutineManageActionV1;
  routineId?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  trigger?: "webhook" | { composio: ConnectionTriggerV1 };
  timezone?: string;
  userAsked?: boolean;
}

function decodeRoutineManageInputV1(input: unknown): RoutineManageInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RoutineDecodeError("routine_manage input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "action",
    "routineId",
    "name",
    "prompt",
    "schedule",
    "trigger",
    "timezone",
    "userAsked",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RoutineDecodeError(
        `routine_manage input has unknown field "${key}"`,
      );
    }
  }
  const action = ROUTINE_MANAGE_ACTIONS.find((known) => known === value.action);
  if (!action) {
    throw new RoutineDecodeError("routine_manage action is unknown");
  }
  const optional = (key: keyof RoutineManageInputV1): string | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "string") {
      throw new RoutineDecodeError(`routine_manage ${key} must be a string`);
    }
    return candidate;
  };
  let trigger: RoutineManageInputV1["trigger"];
  if (value.trigger === "webhook") trigger = "webhook";
  else if (value.trigger !== undefined) {
    if (
      !value.trigger ||
      typeof value.trigger !== "object" ||
      Array.isArray(value.trigger) ||
      Object.keys(value.trigger).some((key) => key !== "composio") ||
      !("composio" in value.trigger)
    )
      throw new RoutineDecodeError("Choose a service event or webhook trigger");
    trigger = { composio: decodeConnectionTriggerV1(value.trigger.composio) };
  }
  if (value.userAsked !== undefined && typeof value.userAsked !== "boolean") {
    throw new RoutineDecodeError("routine_manage userAsked must be a boolean");
  }
  return {
    action,
    ...(optional("routineId") === undefined
      ? {}
      : { routineId: optional("routineId")! }),
    ...(optional("name") === undefined ? {} : { name: optional("name")! }),
    ...(optional("prompt") === undefined
      ? {}
      : { prompt: optional("prompt")! }),
    ...(optional("schedule") === undefined
      ? {}
      : { schedule: optional("schedule")! }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(optional("timezone") === undefined
      ? {}
      : { timezone: optional("timezone")! }),
    ...(value.userAsked === undefined
      ? {}
      : { userAsked: value.userAsked as boolean }),
  };
}

const COMMAND_ID_CHARACTER = /[^a-zA-Z0-9._-]/g;

/**
 * The command id one tool call uses. It is derived from the Turn's effect
 * identifier, so a reconciled or retried call replays the recorded receipt
 * instead of writing a second Routine.
 */
export function routineToolCommandIdV1(effectId: string): string {
  const sanitized = effectId.replace(COMMAND_ID_CHARACTER, "-").slice(0, 120);
  return `rt-${sanitized || "call"}`;
}

/**
 * The command one tool call becomes. Exported because it is the whole
 * translation from a model's words to a durable command, and it is worth
 * testing without a host.
 */
export function routineManageCommandV1(
  input: RoutineManageInputV1,
  meta: { botId: string; commandId: string },
): RoutineCommandV1 {
  const base = {
    schemaVersion: 1 as const,
    commandId: meta.commandId,
    botId: meta.botId,
  };
  if (input.action === "create") {
    return decodeRoutineCommandV1({
      ...base,
      type: "routine/create",
      ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
      name: input.name,
      prompt: input.prompt,
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.trigger === undefined
        ? {}
        : {
            trigger:
              input.trigger === "webhook"
                ? { kind: "webhook" }
                : { kind: "connection", ...input.trigger.composio },
          }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    });
  }
  if (input.routineId === undefined) {
    throw new RoutineDecodeError(
      `routine_manage ${input.action} needs a routineId`,
    );
  }
  if (input.action === "update") {
    return decodeRoutineCommandV1({
      ...base,
      type: "routine/update",
      routineId: input.routineId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.trigger === undefined
        ? {}
        : {
            trigger:
              input.trigger === "webhook"
                ? { kind: "webhook" }
                : { kind: "connection", ...input.trigger.composio },
          }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    });
  }
  return decodeRoutineCommandV1({
    ...base,
    type:
      input.action === "run_now" ? "routine/run" : `routine/${input.action}`,
    routineId: input.routineId,
  });
}

/**
 * Whether the User, rather than this Bot, created the Routine.
 *
 * A listing that cannot be read answers `true`: not knowing who owns a Routine
 * is a reason to ask, not a reason to switch it off. A Routine that is not in
 * the listing at all is gone, and the command below will say so properly.
 */
async function userAuthoredRoutineV1(
  host: RoutinesRuntimeHostV1,
  routineId: string,
): Promise<boolean> {
  try {
    const listing = await host.list();
    const routine = listing.routines.find(
      (candidate) => candidate.routineId === routineId,
    );
    return routine === undefined ? false : routine.createdBy.kind === "user";
  } catch {
    return true;
  }
}

function refusal(reason: string): { content: string; isError: boolean } {
  return { content: `routine_manage was refused: ${reason}`, isError: true };
}

export function createRoutineManageTool(
  host: RoutinesRuntimeHostV1 & { writer: RoutineWriterIdentityV1 },
): ToolDefinition {
  return {
    name: "routine_manage",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description: [
      "Create, edit, pause, resume, delete, or immediately run one of your own Routines. Use list_triggers to list events and configuration schemas on the User’s existing connected accounts.",
      "A Routine is a standing instruction that fires on a schedule or on a delivered webhook,",
      `as its own Turn rather than inside this conversation. Names are at most ${ROUTINE_NAME_MAX_LENGTH}`,
      `characters and prompts at most ${ROUTINE_PROMPT_MAX_LENGTH}.`,
      "Pausing, editing, or deleting a Routine the User created switches off something they set up,",
      "so do it only when the User asked you to in this conversation, and pass userAsked: true when they did.",
      "If a Routine of theirs is failing or looks wrong, tell them and let them decide — do not switch it off yourself.",
      "Say in your reply whatever you changed.",
    ].join(" "),
    inputSchema: ROUTINE_MANAGE_INPUT_SCHEMA as unknown as Record<
      string,
      unknown
    >,
    idempotent: false,
    validate: (input: unknown) => {
      try {
        decodeRoutineManageInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: RoutineManageInputV1;
      let command: RoutineCommandV1;
      try {
        decoded = decodeRoutineManageInputV1(input);
        if (decoded.action === "list_triggers")
          return {
            content: JSON.stringify(
              (await host.listTriggers?.()) ?? { schemaVersion: 1, items: [] },
            ),
            isError: false,
          };
        command = routineManageCommandV1(decoded, {
          botId: host.botId,
          commandId: routineToolCommandIdV1(context.effectId),
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      // A Bot paused a User's Routine in a Turn about sheep farming, with no
      // approval, no confirmation, and nothing in the transcript saying so.
      // The User's own Routines are theirs: switching one off, or rewriting
      // it, needs the User to have asked for it in this conversation. The
      // Bot's own Routines it may manage freely — those are its housekeeping.
      if (
        DESTRUCTIVE_ROUTINE_ACTIONS.has(decoded.action) &&
        decoded.userAsked !== true &&
        decoded.routineId !== undefined &&
        (await userAuthoredRoutineV1(host, decoded.routineId))
      ) {
        return refusal(
          `Routine ${decoded.routineId} was created by the User. Ask them before you ${decoded.action === "update" ? "change" : decoded.action} it, and call this again with userAsked: true once they say so.`,
        );
      }
      const writer: RoutineWriterV1 = {
        kind: "bot",
        botId: host.botId,
        sessionId: host.writer.sessionId,
        turnId: host.writer.turnId,
      };
      let receipt: RoutineCommandReceiptV1;
      try {
        receipt = await host.execute(command, writer);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      if (receipt.status === "deleted") {
        return {
          content: `Deleted Routine ${receipt.routineId}.`,
          isError: false,
        };
      }
      if (receipt.status === "fired") {
        return {
          content: [
            `Routine ${receipt.routineId} is queued to fire as run ${receipt.fireId}.`,
            "It runs as its own Turn once this one ends; it does not run inside this conversation.",
          ].join(" "),
          isError: false,
        };
      }
      const routine = receipt.routine;
      const timing = routine.schedule
        ? `schedule ${routine.schedule} (${routine.timezone})`
        : routine.trigger?.kind === "connection"
          ? (routine.eventName ?? "a service event")
          : "webhook trigger";
      return {
        content: [
          `Routine "${routine.name}" (${routine.routineId}) is ${
            routine.enabled ? "enabled" : "paused"
          } on ${timing}.`,
          "It is recorded with your provenance and takes effect from your next firing.",
        ].join(" "),
        isError: false,
      };
    },
  };
}

/**
 * The runtime Contribution. `routine_manage` declares no `admission`, so it is
 * offered on every turn type its Capability's manifest ceiling allows — it is a
 * work tool, and the Capability names all four turn types.
 */
export function createRoutinesRuntimePlugin(
  host: RoutinesRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const writer = host.writer;
    if (!writer) return () => {};
    const dispose = ctx.tools.register(
      createRoutineManageTool({ ...host, writer }),
    );
    return () => dispose();
  };
  plugin.inject = ["tools"];
  return plugin;
}
