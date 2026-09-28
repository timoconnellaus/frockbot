// The Routines runtime Contribution: one tool, `routine_manage`.
//
// GrokBot's `update_state target=routine {create,update,pause,resume,delete}`
// reaches FrockBot as a single tool that calls the same command path the hosted
// client calls. There is no second way to write a Routine, so a Bot editing its
// own Routine and a User editing it produce the same durable record with
// different recorded provenance.
//
// "Self-modification never widens authority": a Bot-authored Routine runs as the
// Bot, with the User's enabled Packages and Connections. Nothing here grants
// anything.
//
// `run_now` fires the Routine out of band. It enqueues rather than runs: the
// tool is called from inside an admitted Turn, and a Bot Durable Object holds
// exactly one run at a time, so the firing is durable immediately and lands the
// moment the calling Turn settles. "Queue, never drop, never parallel."
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  decodeSendToUserPayloadV1,
  type AgentRuntimeV1,
  type RuntimeFeatureV1,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@frockbot/core/contracts";
import { recordSendToUserV1 } from "../shell/agent.js";
import { routineApprovalWordingV1 } from "./approval.js";
import { nextRoutineRunV1, normalizeRoutineScheduleV1 } from "./cron.js";
import {
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
  decodeRoutineTriggerConfigV1,
  RoutineDecodeError,
  type RoutineTriggerConfigV1,
  type RoutineTriggerV1,
  type RoutineWriterV1,
} from "./records.js";
import {
  decodeRoutineCommandV1,
  type RoutineCommandReceiptV1,
  type RoutineCommandV1,
  type RoutineListViewV1,
  type RoutineViewV1,
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
export interface RoutineConnectionTriggerOfferV1 {
  connectionId: string;
  connectionLabel: string;
  toolkitName: string;
  slug: string;
  name: string;
  description: string;
}

export interface RoutinesRuntimeHostV1 {
  botId: string;
  writer?: RoutineWriterIdentityV1;
  list(): Promise<RoutineListViewV1>;
  execute(
    command: RoutineCommandV1,
    writer: RoutineWriterV1,
  ): Promise<RoutineCommandReceiptV1>;
  /** Connected-app events this Bot may start a Routine on. Absent means none. */
  listTriggers?(): Promise<RoutineConnectionTriggerOfferV1[]>;
  /**
   * Record a Routine change the person must approve before it is armed
   * (`app/routines/approval.ts`), keyed by this Turn's occurrence, and answer
   * the Approval it asks under. Idempotent: a replayed occurrence answers the
   * same id. Absent where no approval can be asked, and then such a change is
   * refused.
   */
  askApproval?(request: {
    command: RoutineCommandV1;
    effectId: string;
  }): Promise<{ approvalId: string }>;
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
        "A five-field cron expression, or @hourly, @daily, @weekly, @monthly, or @every 15m. It runs in the User's Profile time zone. A Routine has a schedule or a trigger, never both.",
    },
    trigger: {
      type: "string",
      enum: ["webhook"],
      description:
        "Fire on a delivered webhook rather than on a clock. A Routine has a schedule or a trigger, never both.",
    },
    connectionTrigger: {
      type: "object",
      description:
        "Fire on an event from a connected app — a new Gmail message, an email sent, and the rest list_triggers offers. Exclusive with schedule, trigger and pluginTrigger. The User must have connected the app.",
      properties: {
        connectionId: {
          type: "string",
          description: "The Connection that owns the app account.",
        },
        triggerType: {
          type: "string",
          description:
            "The event slug list_triggers returned, e.g. GMAIL_NEW_GMAIL_MESSAGE.",
        },
        config: {
          type: "object",
          description:
            "Optional Gmail search that narrows which events fire. Only query is allowed.",
          properties: {
            query: {
              type: "string",
              description:
                "A Gmail search, e.g. from:stripe.com. Omit config unless this search narrows the event.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      required: ["connectionId", "triggerType"],
      additionalProperties: false,
    },
    pluginTrigger: {
      type: "object",
      description:
        "Fire on a delivery one of this account's Plugins handles first: the Plugin reads the delivery through its exported trigger and answers with the text this Routine runs on, or drops it. The Plugin must be on for this Bot. Exclusive with schedule and trigger.",
      properties: {
        pluginId: { type: "string", description: "The Plugin's id." },
        trigger: {
          type: "string",
          description:
            "The trigger the Plugin exports and declares in plugin.json.",
        },
      },
      required: ["pluginId", "trigger"],
      additionalProperties: false,
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

interface RoutineManageInputV1 {
  action: RoutineManageActionV1;
  routineId?: string;
  name?: string;
  prompt?: string;
  schedule?: string;
  trigger?: "webhook";
  pluginTrigger?: { pluginId: string; trigger: string };
  connectionTrigger?: {
    connectionId: string;
    triggerType: string;
    config?: RoutineTriggerConfigV1;
  };
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
    "pluginTrigger",
    "connectionTrigger",
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
  else if (value.trigger !== undefined)
    throw new RoutineDecodeError('routine_manage trigger must be "webhook"');
  let pluginTrigger: RoutineManageInputV1["pluginTrigger"];
  if (value.pluginTrigger !== undefined) {
    const candidate = value.pluginTrigger;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof (candidate as Record<string, unknown>).pluginId !== "string" ||
      typeof (candidate as Record<string, unknown>).trigger !== "string"
    ) {
      throw new RoutineDecodeError(
        "routine_manage pluginTrigger must name a pluginId and a trigger",
      );
    }
    if (trigger !== undefined) {
      throw new RoutineDecodeError(
        "routine_manage takes a trigger or a pluginTrigger, never both",
      );
    }
    pluginTrigger = {
      pluginId: (candidate as { pluginId: string }).pluginId,
      trigger: (candidate as { trigger: string }).trigger,
    };
  }
  let connectionTrigger: RoutineManageInputV1["connectionTrigger"];
  if (value.connectionTrigger !== undefined) {
    const candidate = value.connectionTrigger;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof (candidate as Record<string, unknown>).connectionId !== "string" ||
      typeof (candidate as Record<string, unknown>).triggerType !== "string"
    ) {
      throw new RoutineDecodeError(
        "routine_manage connectionTrigger must name a connectionId and a triggerType",
      );
    }
    if (trigger !== undefined || pluginTrigger !== undefined) {
      throw new RoutineDecodeError(
        "routine_manage takes one of trigger, pluginTrigger, or connectionTrigger",
      );
    }
    const named = candidate as {
      connectionId: string;
      triggerType: string;
      config?: unknown;
    };
    connectionTrigger = {
      connectionId: named.connectionId,
      triggerType: named.triggerType,
      ...(named.config === undefined
        ? {}
        : {
            config: decodeRoutineTriggerConfigV1(
              named.config,
              "routine_manage connectionTrigger config",
            ),
          }),
    };
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
    ...(pluginTrigger === undefined ? {} : { pluginTrigger }),
    ...(connectionTrigger === undefined ? {} : { connectionTrigger }),
  };
}

/**
 * The command id one tool call uses. It is derived from the Turn's run and
 * effect identifier, so a reconciled or retried call replays the recorded
 * receipt instead of writing a second Routine. The run is there because effect
 * ids restart in every Session, and run ids are unique within the Bot whose
 * Routines these are.
 */
export async function routineToolCommandIdV1(
  runId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(`${runId}\u0000${effectId}`);
  return `rt-${digest.slice(0, 32)}`;
}

/**
 * The command one tool call becomes. Exported because it is the whole
 * translation from a model's words to a durable command, and it is worth
 * testing without a host.
 */
/** The trigger record a tool call names, if it names one. */
function routineTriggerOfInputV1(
  input: RoutineManageInputV1,
): RoutineTriggerV1 | undefined {
  if (input.pluginTrigger !== undefined) {
    return {
      kind: "plugin",
      pluginId: input.pluginTrigger.pluginId,
      trigger: input.pluginTrigger.trigger,
    };
  }
  if (input.connectionTrigger !== undefined) {
    return {
      kind: "connection",
      connectionId: input.connectionTrigger.connectionId,
      triggerType: input.connectionTrigger.triggerType,
      ...(input.connectionTrigger.config === undefined
        ? {}
        : { config: input.connectionTrigger.config }),
    };
  }
  return input.trigger === undefined ? undefined : { kind: "webhook" };
}

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
      ...(routineTriggerOfInputV1(input) === undefined
        ? {}
        : { trigger: routineTriggerOfInputV1(input) }),
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
      ...(routineTriggerOfInputV1(input) === undefined
        ? {}
        : { trigger: routineTriggerOfInputV1(input) }),
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
 * The Routine a command names, as the listing holds it: `undefined` when it
 * is not there (the command then says so properly), `null` when the listing
 * cannot be read — not knowing whose a Routine is is a reason to ask.
 */
async function currentRoutineV1(
  host: RoutinesRuntimeHostV1,
  routineId: string,
): Promise<RoutineViewV1 | undefined | null> {
  try {
    const listing = await host.list();
    return listing.routines.find(
      (candidate) => candidate.routineId === routineId,
    );
  } catch {
    return null;
  }
}

/**
 * Whether the person must approve a change on a card before it is armed.
 *
 * A Routine's prompt speaks for the person every time it fires, so writing
 * one — creating it, or changing what an existing one asks or when it runs —
 * is theirs to approve, whoever proposes it. Pausing or deleting one they set
 * up switches off something of theirs. Renaming, resuming and running now
 * change none of that, and pausing or deleting a Routine the Bot itself set
 * up is its own housekeeping.
 */
export function routineChangeNeedsApprovalV1(
  command: RoutineCommandV1,
  current: Pick<RoutineViewV1, "createdBy"> | undefined | null,
): boolean {
  switch (command.type) {
    case "routine/create":
      return true;
    case "routine/update":
      return (
        command.prompt !== undefined ||
        command.schedule !== undefined ||
        command.trigger !== undefined
      );
    case "routine/pause":
    case "routine/delete":
      return current === null || current?.createdBy.kind === "user";
    default:
      return false;
  }
}

function refusal(reason: string): { content: string; isError: boolean } {
  return { content: `routine_manage was refused: ${reason}`, isError: true };
}

/** Where a card is recorded and drawn: the Turn's Sessions and the card seam. */
export type RoutineApprovalRuntimeV1 = Pick<
  AgentRuntimeV1,
  "sessions" | "firstPartyCards"
>;

/**
 * Record the change and put it to the person on an approval card on this
 * Turn's log. The intent is durable before the card; both are keyed by the
 * occurrence, so a replayed call asks nothing twice.
 */
async function askRoutineApproval(
  host: RoutinesRuntimeHostV1,
  runtime: RoutineApprovalRuntimeV1 | undefined,
  command: RoutineCommandV1,
  current: RoutineViewV1 | undefined | null,
  context: ToolExecutionContext,
): Promise<{ content: string; isError: boolean }> {
  // A subagent runs in its own object, whose Approvals the Bot never reads.
  if (!host.askApproval || !runtime || context.turnType === "subagent") {
    return refusal(
      "this change needs the User's approval on a card, which cannot be asked from here. Hand it back to the conversation, saying exactly what the change is.",
    );
  }
  // The person is never asked to approve a change that cannot be applied.
  if (command.type !== "routine/create" && current === undefined) {
    return refusal(`there is no Routine "${command.routineId}"`);
  }
  const schedule =
    command.type === "routine/create" || command.type === "routine/update"
      ? command.schedule
      : undefined;
  if (schedule !== undefined) {
    try {
      const normalized = normalizeRoutineScheduleV1(schedule, "UTC");
      const now = new Date();
      if (nextRoutineRunV1(normalized, now, now) === undefined) {
        return refusal(`schedule "${schedule}" never comes around again`);
      }
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  }
  const wording = routineApprovalWordingV1(command, current ?? undefined);
  if (!wording) {
    return refusal(
      "the prompt is too long to show the User whole on an approval card. Shorten it and ask again.",
    );
  }
  let approvalId: string;
  try {
    ({ approvalId } = await host.askApproval({
      command,
      effectId: context.effectId,
    }));
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error));
  }
  const payload = decodeSendToUserPayloadV1(
    { type: "approval", approvalId, ...wording },
    "Routine approval",
    // Minted by the host from this occurrence; the prefix is refused to
    // every other author.
    { kernelMinted: true },
  );
  const recorded = await recordSendToUserV1(runtime.sessions, payload, {
    sessionId: context.sessionId,
    occurrenceId: context.effectId,
    tool: "routine_manage",
    ...(runtime.firstPartyCards === undefined
      ? {}
      : { cards: runtime.firstPartyCards }),
    context,
  });
  if (recorded.status !== "sent") {
    return refusal(`the approval could not be asked: ${recorded.reason}`);
  }
  return {
    content: [
      `Asked the User to approve this on a card (approval ${approvalId}): ${wording.action}.`,
      "Nothing is armed or changed until they approve. Do not make this change again; their answer opens a Turn of yours that says what came of it.",
    ].join(" "),
    isError: false,
  };
}

export function createRoutineManageTool(
  host: RoutinesRuntimeHostV1 & { writer: RoutineWriterIdentityV1 },
  runtime?: RoutineApprovalRuntimeV1,
): ToolDefinition {
  return {
    name: "routine_manage",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description: [
      "Create, edit, pause, resume, delete, or immediately run one of your own Routines.",
      "You are the only author: the User asks you in conversation, and there is no form.",
      "Write the prompt so it names the kind of event this Routine is for — a shipping confirmation, an invoice — because a connected-app event that is clearly not that kind is skipped before you run.",
      "list_triggers lists the connected-app events a Routine may fire on.",
      "A Routine is a standing instruction that fires on a schedule, a delivered webhook,",
      "or a connected-app event,",
      `as its own Turn rather than inside this conversation. Names are at most ${ROUTINE_NAME_MAX_LENGTH}`,
      `characters and prompts at most ${ROUTINE_PROMPT_MAX_LENGTH}.`,
      "One connected-app event is one firing. To sweep an inbox, use a schedule and fetch.",
      "connectionTrigger.config is only for a coarse search such as Gmail query. Never set labelIds, userId, or interval.",
      "Creating a Routine, changing its prompt, schedule or trigger, and pausing or deleting one the User created each put an approval card in front of the User:",
      "nothing is armed or switched off until they approve it, and their answer opens a Turn of yours that says what came of it.",
      "Once approved, a Routine's prompt is their standing request. Renaming, resuming, running now, and pausing or deleting a Routine you created need no card.",
      "If a Routine of theirs is failing or looks wrong, tell them and let them decide — do not switch it off yourself.",
      "Say in your reply whatever you changed or asked.",
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
        if (decoded.action === "list_triggers") {
          const offers = host.listTriggers ? await host.listTriggers() : [];
          if (offers.length === 0) {
            return {
              content:
                "No connected apps offer events yet. Connect Gmail or another app, then ask again.",
              isError: false,
            };
          }
          return {
            content: [
              "Connected-app events a Routine may fire on:",
              ...offers.map(
                (offer) =>
                  `- ${offer.toolkitName} (${offer.connectionId} · ${offer.connectionLabel}): ${offer.slug} — ${offer.name}. ${offer.description}`,
              ),
              "Create a Routine with connectionTrigger: { connectionId, triggerType } using the slug as triggerType.",
              "Write the prompt so it names the kind of mail or event. Set config.query only when a Gmail search can narrow it; never set labelIds, userId, or interval.",
              "One event is one firing. Inbox sweeps are a schedule.",
            ].join("\n"),
            isError: false,
          };
        }
        command = routineManageCommandV1(decoded, {
          botId: host.botId,
          commandId: await routineToolCommandIdV1(
            host.writer.runId,
            context.effectId,
          ),
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      // A Bot paused a User's Routine in a Turn about avatar farming, and a
      // Bot could vouch for itself with a flag it set. What a Routine asks for
      // is the person's standing request, so writing one is theirs to approve
      // on a card bound to exactly this command; nothing is armed until then.
      const current =
        "routineId" in command && command.routineId !== undefined
          ? await currentRoutineV1(host, command.routineId)
          : undefined;
      if (routineChangeNeedsApprovalV1(command, current)) {
        return askRoutineApproval(host, runtime, command, current, context);
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
          ? `app event ${routine.trigger.triggerType}`
          : routine.trigger?.kind === "plugin"
            ? `plugin trigger ${routine.trigger.pluginId}/${routine.trigger.trigger}`
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
export function createRoutinesRuntimeFeature(
  host: RoutinesRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const writer = host.writer;
    if (!writer) return () => {};
    const dispose = runtime.tools.register(
      createRoutineManageTool({ ...host, writer }, runtime),
    );
    return () => dispose();
  };
}
