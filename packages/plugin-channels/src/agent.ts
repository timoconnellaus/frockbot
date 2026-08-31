// The Channels runtime Contribution: three tools and two prompt sections.
//
// Register rows 35, 36 and `:444-445`. `SendToAgent` is "a fire-and-forget
// message to another agent or a group"; `ReactToMessage` is an emoji tapback on
// a message address; `CreateChannel`/`UpdateChannel` reach FrockBot as one
// `channel_manage` tool, as `update_state target=routine` reached it as one
// `routine_manage`.
//
// All three are admitted on `["chat", "channel"]` and on nothing else. `chat`
// is parity — GrokBot gates both to the parent chat path and keeps them out of
// automation catalogs. `channel` is the FrockBot extension that makes a group
// conversation closed rather than one-way: without it a recipient could hear a
// message and have no way to answer.
//
// Nothing here has authority of its own. Every write goes through the host's
// `execute`, which reaches the User Durable Object's `ChannelStore`, and a
// refusal comes back as a recorded receipt this tool reads out to the model.
import type {
  ToolDefinition,
  ToolExecutionContext,
  TurnTypeV1,
} from "@frockbot/kernel-contracts";
import { decodeTurnTypeV1 } from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  CHANNEL_HOP_MAX,
  CHANNEL_MEMBER_MAX,
  CHANNEL_NAME_MAX,
  CHANNEL_TEXT_MAX,
  ChannelDecodeError,
  pairChannelIdV1,
  type ChannelWriterV1,
} from "./records.js";
import {
  channelPromptAdmittedV1,
  CHANNELS_SECTION_ID,
  renderChannelsSectionV1,
  renderTeammatesSectionV1,
  TEAMMATES_SECTION_ID,
} from "./prompt.js";
import type {
  ChannelsRuntimeHostV1,
  ChannelWriterIdentityV1,
} from "./agent-host.js";
import type { ChannelCommandReceiptV1, ChannelCommandV1 } from "./shared.js";
import manifest from "../frockbot.json" with { type: "json" };

export const SEND_TO_AGENT_TOOL_V1 = "send_to_agent";
export const REACT_TO_MESSAGE_TOOL_V1 = "react_to_message";
export const CHANNEL_MANAGE_TOOL_V1 = "channel_manage";

/** The manifest Capability the three tools are contributed under. */
export const CHANNEL_TOOLS_CAPABILITY_V1 = "channel-tools";

/** The turn types the tools declare, and the manifest's ceiling on them. */
export const CHANNEL_TURN_TYPES_V1: readonly TurnTypeV1[] = ["chat", "channel"];

/**
 * The durable ceiling this Package's own manifest puts on its Capability, read
 * back out of the manifest rather than restated here. A registration that
 * drifted from the manifest would be narrowed to the manifest, so the two
 * cannot disagree about what a turn type admits.
 */
export function channelAdmissionCeilingV1(
  capabilityId: string = CHANNEL_TOOLS_CAPABILITY_V1,
): readonly TurnTypeV1[] | undefined {
  const capabilities = (
    manifest as {
      configuration?: {
        capabilities?: Array<{
          id: string;
          admission?: { turnTypes: string[] };
        }>;
      };
    }
  ).configuration?.capabilities;
  const turnTypes = capabilities?.find(
    (candidate) => candidate.id === capabilityId,
  )?.admission?.turnTypes;
  if (!turnTypes) return undefined;
  return turnTypes.map((turnType) =>
    decodeTurnTypeV1(
      turnType,
      `channels capability "${capabilityId}" admission`,
    ),
  );
}

const COMMAND_ID_CHARACTER = /[^a-zA-Z0-9._-]/g;

function sanitized(value: string, limit: number): string {
  return value.replace(COMMAND_ID_CHARACTER, "-").slice(0, limit) || "x";
}

/**
 * The command id one tool call uses.
 *
 * Derived from the Turn's effect identifier, so a reconciled or retried call
 * replays the recorded receipt instead of posting a second message — and from
 * the Bot and the run as well, because the receipts live in the **User**
 * Durable Object and an effect id is only unique inside one Turn. Two Bots
 * taking their first tool call would otherwise present the same command id for
 * two different commands.
 */
export function channelToolCommandIdV1(
  scope: { botId: string; runId: string },
  effectId: string,
): string {
  return [
    "cx",
    sanitized(scope.botId, 30),
    sanitized(scope.runId, 50),
    sanitized(effectId, 25),
  ].join("-");
}

function refusal(
  tool: string,
  reason: string,
): { content: string; isError: boolean } {
  return { content: `${tool} was refused: ${reason}`, isError: true };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ChannelDecodeError("input must be an object");
  }
  return input as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new ChannelDecodeError(`${tool} ${key} must be a non-empty string`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new ChannelDecodeError(`${tool} ${key} must be a string`);
  }
  return candidate;
}

function stringArray(
  value: Record<string, unknown>,
  key: string,
  tool: string,
): string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (
    !Array.isArray(candidate) ||
    candidate.some((entry) => typeof entry !== "string")
  ) {
    throw new ChannelDecodeError(`${tool} ${key} must be an array of Bot ids`);
  }
  return candidate as string[];
}

function writerFor(
  host: ChannelsRuntimeHostV1 & { writer: ChannelWriterIdentityV1 },
): ChannelWriterV1 {
  return {
    kind: "bot",
    botId: host.botId,
    sessionId: host.writer.sessionId,
    turnId: host.writer.turnId,
  };
}

/** What a refused receipt says to the model. Refusals are answers, not errors. */
function refusalContent(
  tool: string,
  receipt: Extract<ChannelCommandReceiptV1, { status: "refused" }>,
): { content: string; isError: boolean } {
  return refusal(tool, receipt.reason);
}

const SEND_TO_AGENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    botId: {
      type: "string",
      description:
        "A teammate's id, to reach it one to one. Give this or channelId, not both.",
    },
    channelId: {
      type: "string",
      description: "A channel you are a member of. Give this or botId.",
    },
    text: {
      type: "string",
      description: "The message. The recipients read exactly this.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

/**
 * `send_to_agent`.
 *
 * A bare `botId` resolves to the implicit 1:1 pair Channel — the id is derived
 * from the pair, so both Bots name the same room and neither has to have
 * created it. The create is issued first and is idempotent on that derived id.
 *
 * The `hop` this post carries is the host's: a post from a chat Turn is hop 1,
 * and a post from a `channel` Turn is one more than the message that woke it.
 * That is what makes the cascade finite, and it is deliberately not something
 * the model can choose.
 */
export function createSendToAgentTool(
  host: ChannelsRuntimeHostV1 & { writer: ChannelWriterIdentityV1 },
): ToolDefinition {
  return {
    name: SEND_TO_AGENT_TOOL_V1,
    description: [
      "Send one message to a teammate or to a channel. Fire and forget: they read it on a turn of their own,",
      "and nothing comes back to this turn. Name either botId or channelId, never both.",
      `Messages are at most ${CHANNEL_TEXT_MAX} characters, and a chain of replies stops after ${CHANNEL_HOP_MAX} hops.`,
    ].join(" "),
    inputSchema: structuredClone(SEND_TO_AGENT_INPUT_SCHEMA) as Record<
      string,
      unknown
    >,
    admission: { turnTypes: [...CHANNEL_TURN_TYPES_V1] },
    idempotent: false,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let target: { botId?: string; channelId?: string };
      let text: string;
      try {
        const value = objectInput(input);
        text = requiredString(value, "text", SEND_TO_AGENT_TOOL_V1);
        const botId = optionalString(value, "botId", SEND_TO_AGENT_TOOL_V1);
        const channelId = optionalString(
          value,
          "channelId",
          SEND_TO_AGENT_TOOL_V1,
        );
        if ((botId === undefined) === (channelId === undefined)) {
          throw new ChannelDecodeError(
            "name exactly one of botId and channelId",
          );
        }
        target = {
          ...(botId === undefined ? {} : { botId }),
          ...(channelId === undefined ? {} : { channelId }),
        };
      } catch (error) {
        return refusal(
          SEND_TO_AGENT_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const commandId = channelToolCommandIdV1(
        { botId: host.botId, runId: host.writer.runId },
        context.effectId,
      );
      const writer = writerFor(host);
      let channelId = target.channelId;
      if (channelId === undefined) {
        // The implicit pair Channel. Creating it is idempotent on the derived
        // id, so the first Bot to speak opens the room and the second finds it.
        try {
          channelId = pairChannelIdV1(host.botId, target.botId!);
        } catch (error) {
          return refusal(
            SEND_TO_AGENT_TOOL_V1,
            error instanceof Error ? error.message : String(error),
          );
        }
        const opened = await execute(host, writer, {
          schemaVersion: 1,
          type: "channel/create",
          commandId: `${commandId}-open`,
          botId: host.botId,
          channelId,
          name: `${host.botId} and ${target.botId}`,
          members: [host.botId, target.botId!],
        });
        if (opened instanceof Error) {
          return refusal(SEND_TO_AGENT_TOOL_V1, opened.message);
        }
        if (opened.status === "refused") {
          return refusalContent(SEND_TO_AGENT_TOOL_V1, opened);
        }
      }
      const receipt = await execute(host, writer, {
        schemaVersion: 1,
        type: "channel/post",
        commandId,
        botId: host.botId,
        channelId,
        text,
        hop: (host.origin?.hop ?? 0) + 1,
      });
      if (receipt instanceof Error) {
        return refusal(SEND_TO_AGENT_TOOL_V1, receipt.message);
      }
      if (receipt.status === "refused") {
        return refusalContent(SEND_TO_AGENT_TOOL_V1, receipt);
      }
      if (receipt.status !== "posted") {
        return refusal(
          SEND_TO_AGENT_TOOL_V1,
          "the Channel did not record a message",
        );
      }
      const recipients = receipt.recipients;
      return {
        content: [
          `Posted to channel ${receipt.channel.channelId} as message ${receipt.message.messageId}.`,
          recipients.length === 0
            ? "Nobody else is in that channel yet, so nobody was woken."
            : `${recipients.join(", ")} will read it on a turn of their own; nothing comes back to this one.`,
        ].join(" "),
        isError: false,
      };
    },
  };
}

const REACT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    channelId: {
      type: "string",
      description: "The channel the message is in.",
    },
    messageId: { type: "string", description: "The message to react to." },
    emoji: { type: "string", description: "One emoji." },
  },
  required: ["channelId", "messageId", "emoji"],
  additionalProperties: false,
} as const;

/**
 * `react_to_message`.
 *
 * A tapback produces **no** input: nobody is woken by it, so it cannot cascade
 * and it is the one Channel write with no loop bound to check. It is idempotent
 * on `(messageId, botId, emoji)`, so reacting twice is reacting once.
 */
export function createReactToMessageTool(
  host: ChannelsRuntimeHostV1 & { writer: ChannelWriterIdentityV1 },
): ToolDefinition {
  return {
    name: REACT_TO_MESSAGE_TOOL_V1,
    description: [
      "React to one message in a channel with a single emoji. Nobody is woken by a reaction:",
      "it is a tapback, not a message. Reacting twice with the same emoji changes nothing.",
    ].join(" "),
    inputSchema: structuredClone(REACT_INPUT_SCHEMA) as Record<string, unknown>,
    admission: { turnTypes: [...CHANNEL_TURN_TYPES_V1] },
    idempotent: true,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let command: ChannelCommandV1;
      try {
        const value = objectInput(input);
        command = {
          schemaVersion: 1,
          type: "channel/react",
          commandId: channelToolCommandIdV1(
            { botId: host.botId, runId: host.writer.runId },
            context.effectId,
          ),
          botId: host.botId,
          channelId: requiredString(
            value,
            "channelId",
            REACT_TO_MESSAGE_TOOL_V1,
          ),
          messageId: requiredString(
            value,
            "messageId",
            REACT_TO_MESSAGE_TOOL_V1,
          ),
          emoji: requiredString(value, "emoji", REACT_TO_MESSAGE_TOOL_V1),
        };
      } catch (error) {
        return refusal(
          REACT_TO_MESSAGE_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const receipt = await execute(host, writerFor(host), command);
      if (receipt instanceof Error) {
        return refusal(REACT_TO_MESSAGE_TOOL_V1, receipt.message);
      }
      if (receipt.status === "refused") {
        return refusalContent(REACT_TO_MESSAGE_TOOL_V1, receipt);
      }
      if (receipt.status !== "reacted") {
        return refusal(
          REACT_TO_MESSAGE_TOOL_V1,
          "the Channel did not record a reaction",
        );
      }
      return {
        content: receipt.added
          ? `Reacted ${receipt.emoji} to ${receipt.messageId}. Nobody was woken.`
          : `You had already reacted ${receipt.emoji} to ${receipt.messageId}.`,
        isError: false,
      };
    },
  };
}

export const CHANNEL_MANAGE_ACTIONS = [
  "create",
  "update",
  "disconnect",
] as const;

export type ChannelManageActionV1 = (typeof CHANNEL_MANAGE_ACTIONS)[number];

const CHANNEL_MANAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...CHANNEL_MANAGE_ACTIONS],
      description:
        "create opens a channel; update changes its name or membership; disconnect closes it and keeps its history.",
    },
    channelId: {
      type: "string",
      description: "The channel to act on. Required for update and disconnect.",
    },
    name: { type: "string", description: "The channel's display name." },
    memberIds: {
      type: "array",
      items: { type: "string" },
      description:
        "On create: the Bots in the channel, 1 to 6. Include your own id to take part.",
    },
    addMemberIds: {
      type: "array",
      items: { type: "string" },
      description: "On update: Bots to add.",
    },
    removeMemberIds: {
      type: "array",
      items: { type: "string" },
      description: "On update: Bots to remove. A channel is never emptied.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

/**
 * `channel_manage`.
 *
 * Row 35 verbatim: creating takes a name and 1 to 6 member ids, and you include
 * your own id to take part; updating is admitted only for a member, and cannot
 * empty the channel. `disconnect` is `:100`'s `update_state channel
 * disconnect{platform}` — the record and the history survive it.
 */
export function createChannelManageTool(
  host: ChannelsRuntimeHostV1 & { writer: ChannelWriterIdentityV1 },
): ToolDefinition {
  return {
    name: CHANNEL_MANAGE_TOOL_V1,
    description: [
      "Create, edit, or disconnect one channel.",
      `A channel holds 1 to ${CHANNEL_MEMBER_MAX} Bots — include your own id to take part —`,
      `and its name is at most ${CHANNEL_NAME_MAX} characters.`,
      "You may only edit a channel you are a member of, and a channel is never emptied.",
      "Disconnecting keeps the channel and its history and stops new messages.",
    ].join(" "),
    inputSchema: structuredClone(CHANNEL_MANAGE_INPUT_SCHEMA) as Record<
      string,
      unknown
    >,
    admission: { turnTypes: [...CHANNEL_TURN_TYPES_V1] },
    idempotent: false,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let command: ChannelCommandV1;
      try {
        command = channelManageCommandV1(objectInput(input), {
          botId: host.botId,
          commandId: channelToolCommandIdV1(
            { botId: host.botId, runId: host.writer.runId },
            context.effectId,
          ),
        });
      } catch (error) {
        return refusal(
          CHANNEL_MANAGE_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const receipt = await execute(host, writerFor(host), command);
      if (receipt instanceof Error) {
        return refusal(CHANNEL_MANAGE_TOOL_V1, receipt.message);
      }
      if (receipt.status === "refused") {
        return refusalContent(CHANNEL_MANAGE_TOOL_V1, receipt);
      }
      if (receipt.status !== "applied") {
        return refusal(
          CHANNEL_MANAGE_TOOL_V1,
          "the Channel did not record a change",
        );
      }
      const channel = receipt.channel;
      return {
        content: [
          `Channel "${channel.name}" (${channel.channelId}) is ${
            channel.active ? "open" : "disconnected"
          } with ${channel.members.join(", ")}.`,
          channel.members.includes(host.botId)
            ? "You are a member, so its messages reach you."
            : "You are not a member, so you will not see its messages.",
        ].join(" "),
        isError: false,
      };
    },
  };
}

/**
 * The command one `channel_manage` call becomes. Exported because it is the
 * whole translation from a model's words to a durable command, and it is worth
 * testing without a host.
 */
export function channelManageCommandV1(
  input: Record<string, unknown>,
  meta: { botId: string; commandId: string },
): ChannelCommandV1 {
  const allowed = new Set([
    "action",
    "channelId",
    "name",
    "memberIds",
    "addMemberIds",
    "removeMemberIds",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ChannelDecodeError(
        `${CHANNEL_MANAGE_TOOL_V1} input has unknown field "${key}"`,
      );
    }
  }
  const action = CHANNEL_MANAGE_ACTIONS.find((known) => known === input.action);
  if (!action) {
    throw new ChannelDecodeError(`${CHANNEL_MANAGE_TOOL_V1} action is unknown`);
  }
  const base = {
    schemaVersion: 1 as const,
    commandId: meta.commandId,
    botId: meta.botId,
  };
  if (action === "create") {
    const members = stringArray(input, "memberIds", CHANNEL_MANAGE_TOOL_V1);
    if (!members) {
      throw new ChannelDecodeError(
        `${CHANNEL_MANAGE_TOOL_V1} create needs memberIds`,
      );
    }
    return {
      ...base,
      type: "channel/create",
      name: requiredString(input, "name", CHANNEL_MANAGE_TOOL_V1),
      members,
      ...(input.channelId === undefined
        ? {}
        : {
            channelId: requiredString(
              input,
              "channelId",
              CHANNEL_MANAGE_TOOL_V1,
            ),
          }),
    };
  }
  const channelId = requiredString(input, "channelId", CHANNEL_MANAGE_TOOL_V1);
  if (action === "disconnect") {
    return { ...base, type: "channel/disconnect", channelId };
  }
  const name = optionalString(input, "name", CHANNEL_MANAGE_TOOL_V1);
  const add = stringArray(input, "addMemberIds", CHANNEL_MANAGE_TOOL_V1);
  const remove = stringArray(input, "removeMemberIds", CHANNEL_MANAGE_TOOL_V1);
  return {
    ...base,
    type: "channel/update",
    channelId,
    ...(name === undefined ? {} : { name }),
    ...(add === undefined ? {} : { addMemberIds: add }),
    ...(remove === undefined ? {} : { removeMemberIds: remove }),
  };
}

/** One command, with a thrown host failure turned into a value. */
async function execute(
  host: ChannelsRuntimeHostV1,
  writer: ChannelWriterV1,
  command: ChannelCommandV1,
): Promise<ChannelCommandReceiptV1 | Error> {
  try {
    return await host.execute(command, writer);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The runtime Contribution.
 *
 * The tools declare `["chat", "channel"]` and are registered under the
 * manifest's ceiling, which declares the same pair: an automation or subagent
 * Turn is offered none of them, which is `:419` exactly. The two prompt
 * sections are registered on the same turn types, which is `:463-464`.
 */
export function createChannelsRuntimePlugin(
  host: ChannelsRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const writer = host.writer;
    if (!writer) return () => {};
    const bound = { ...host, writer };
    const ceiling = channelAdmissionCeilingV1();
    const options = ceiling ? { admissionCeiling: ceiling } : undefined;
    const disposers = [
      ctx.tools.register(createSendToAgentTool(bound), options),
      ctx.tools.register(createReactToMessageTool(bound), options),
      ctx.tools.register(createChannelManageTool(bound), options),
    ];
    if (channelPromptAdmittedV1(host.turnType ?? "chat")) {
      disposers.push(
        ctx.systemPrompt.register({
          id: TEAMMATES_SECTION_ID,
          order: 40,
          render: async () =>
            renderTeammatesSectionV1({
              selfBotId: host.botId,
              bots: await host.directory(),
            }),
        }),
        ctx.systemPrompt.register({
          id: CHANNELS_SECTION_ID,
          order: 41,
          render: async () =>
            renderChannelsSectionV1({
              selfBotId: host.botId,
              channels: (await host.list()).channels,
            }),
        }),
      );
    }
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools", "systemPrompt"];
  return plugin;
}
