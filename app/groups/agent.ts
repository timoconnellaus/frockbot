// What a Bot can do with Group Chats from its own conversation or a Routine:
// see the groups it is in, start one, change one it is in, archive one, and
// post into one.
//
// Every change is the same command the User's client sends, carried by the
// User object with this Bot as the actor, so a Bot and the User produce the
// same record and the same line in the thread. A Bot never restores or
// deletes a group; the User object refuses it.
import {
  packageAdmissionCeilingV1,
  type AgentRuntimeV1,
  type PromptSection,
  type RuntimeFeatureV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from "@frockbot/core/contracts";
import {
  GROUP_MANAGEMENT_CAPABILITY_V1,
  groupsDefinitionV1,
} from "./definition.js";
import {
  GROUP_CHAT_MEMBERS_MAX_V1,
  GROUP_CHAT_NAME_MAX_V1,
  GROUP_MESSAGE_TEXT_MAX_V1,
  groupDisplayNameV1,
  isGroupIdV1,
  type GroupChatCommandV1,
  type GroupChatReceiptV1,
  type GroupChatRecordV1,
  type GroupMemberV1,
  type GroupMessageV1,
} from "./shared.js";

/** A group this Bot is in, as the tools read it. */
export interface GroupChatSummaryV1 {
  group: GroupChatRecordV1;
  members: GroupMemberV1[];
}

type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;

export interface GroupChatsRuntimeHostV1 {
  /** This Bot. */
  botId: string;
  /** The groups this Bot is a member of. */
  list(): Promise<GroupChatSummaryV1[]>;
  /** The User's Bots, to resolve the names a Bot writes. */
  directory(): Promise<GroupMemberV1[]>;
  /**
   * One command as this Bot. `key` is stable for one tool occurrence and one
   * step of it, so a replayed call reuses its receipt.
   */
  execute(
    command: WithoutCommandId<GroupChatCommandV1>,
    key: string,
  ): Promise<GroupChatReceiptV1>;
  /** A message in a group this Bot is in, posted from here. */
  post(groupId: string, text: string, key: string): Promise<GroupMessageV1>;
}

const LIST_LIMIT = 30;

function refusal(content: string): ToolExecutionResult {
  return { content, isError: true };
}

function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

/** A member named by id or by the name the directory shows. */
function resolveBots(
  wanted: readonly string[],
  directory: readonly GroupMemberV1[],
): { botIds: string[]; unknown: string[] } {
  const botIds: string[] = [];
  const unknown: string[] = [];
  for (const entry of wanted) {
    const needle = entry.replace(/^@/, "").toLowerCase();
    const bot =
      directory.find((candidate) => candidate.botId === entry) ??
      directory.find((candidate) => candidate.name.toLowerCase() === needle);
    if (!bot) unknown.push(entry);
    else if (!botIds.includes(bot.botId)) botIds.push(bot.botId);
  }
  return { botIds, unknown };
}

function describe(summary: GroupChatSummaryV1): string {
  const name = groupDisplayNameV1(summary.group, summary.members);
  const members = summary.members.map((member) => member.name).join(", ");
  return `- ${name} (${summary.group.groupId}): ${members}${summary.group.archivedAt ? " — archived" : ""}`;
}

function failure(tool: string, error: unknown): ToolExecutionResult {
  return refusal(
    `${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const GROUP_ID_PROPERTY = {
  type: "string",
  description: "The group's id, from group_list.",
} as const;

export function createGroupListTool(
  host: GroupChatsRuntimeHostV1,
): ToolDefinition {
  return {
    name: "group_list",
    namespace: "frockbot",
    description:
      "List the group chats you are in, with each one's id and members.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    idempotent: true,
    execute: async () => {
      try {
        const groups = await host.list();
        if (groups.length === 0) return ok("You are not in any group chats.");
        return ok(groups.slice(0, LIST_LIMIT).map(describe).join("\n"));
      } catch (error) {
        return failure("group_list", error);
      }
    },
  };
}

export function createGroupCreateTool(
  host: GroupChatsRuntimeHostV1,
): ToolDefinition {
  return {
    name: "group_create",
    namespace: "frockbot",
    description: `Start a group chat between your User, you, and other Bots of your User's. You are always a member; name 1 to ${GROUP_CHAT_MEMBERS_MAX_V1 - 1} others. Name the group for its purpose.`,
    inputSchema: {
      type: "object",
      properties: {
        members: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: GROUP_CHAT_MEMBERS_MAX_V1 - 1,
          description: "The other Bots, by name or id.",
        },
        name: {
          type: "string",
          maxLength: GROUP_CHAT_NAME_MAX_V1,
          description: "What the group is for.",
        },
      },
      required: ["members"],
      additionalProperties: false,
    },
    // The command id comes from the occurrence, so a replay is the same group.
    idempotent: true,
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const value = record(input);
      const wanted = stringList(value?.members);
      const name =
        typeof value?.name === "string" ? value.name.trim() : undefined;
      if (!value || !wanted || wanted.length === 0) {
        return refusal(
          "group_create was refused: name at least one other Bot in members",
        );
      }
      try {
        const directory = await host.directory();
        const { botIds, unknown } = resolveBots(wanted, directory);
        if (unknown.length > 0) {
          return refusal(
            `group_create was refused: not one of your User's Bots: ${unknown.join(", ")}`,
          );
        }
        const members = [
          host.botId,
          ...botIds.filter((id) => id !== host.botId),
        ];
        const receipt = await host.execute(
          {
            type: "group/create",
            members,
            ...(name ? { name } : {}),
          },
          `${context.effectId}:create`,
        );
        const group = receipt.group;
        return ok(
          group
            ? `Started the group ${groupDisplayNameV1(group, directory)} (${group.groupId}).`
            : `Started the group ${receipt.groupId}.`,
        );
      } catch (error) {
        return failure("group_create", error);
      }
    },
  };
}

export function createGroupUpdateTool(
  host: GroupChatsRuntimeHostV1,
): ToolDefinition {
  return {
    name: "group_update",
    namespace: "frockbot",
    description:
      "Rename a group chat you are in, or add or remove members. Each change is a line in the group. A group keeps 2 to 8 Bots.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: GROUP_ID_PROPERTY,
        name: {
          type: "string",
          maxLength: GROUP_CHAT_NAME_MAX_V1,
          description: "The new name. An empty string clears it.",
        },
        add_members: {
          type: "array",
          items: { type: "string" },
          description: "Bots to add, by name or id.",
        },
        remove_members: {
          type: "array",
          items: { type: "string" },
          description: "Bots to remove, by name or id.",
        },
      },
      required: ["group_id"],
      additionalProperties: false,
    },
    idempotent: true,
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const value = record(input);
      const groupId = value?.group_id;
      const add = stringList(value?.add_members);
      const remove = stringList(value?.remove_members);
      if (!value || !isGroupIdV1(groupId) || !add || !remove) {
        return refusal(
          "group_update was refused: pass a group_id from group_list",
        );
      }
      if (value.name === undefined && add.length === 0 && remove.length === 0) {
        return refusal("group_update was refused: nothing to change");
      }
      try {
        const directory = await host.directory();
        const adding = resolveBots(add, directory);
        const removing = resolveBots(remove, directory);
        const unknown = [...adding.unknown, ...removing.unknown];
        if (unknown.length > 0) {
          return refusal(
            `group_update was refused: not one of your User's Bots: ${unknown.join(", ")}`,
          );
        }
        const done: string[] = [];
        if (typeof value.name === "string") {
          const name = value.name.trim();
          const receipt = await host.execute(
            { type: "group/rename", groupId, name: name || null },
            `${context.effectId}:rename`,
          );
          if (receipt.status === "applied") {
            done.push(name ? `renamed it "${name}"` : "cleared its name");
          }
        }
        for (const botId of adding.botIds) {
          const receipt = await host.execute(
            { type: "group/add-member", groupId, botId },
            `${context.effectId}:add:${botId}`,
          );
          if (receipt.status === "applied") done.push(`added ${botId}`);
        }
        for (const botId of removing.botIds) {
          const receipt = await host.execute(
            { type: "group/remove-member", groupId, botId },
            `${context.effectId}:remove:${botId}`,
          );
          if (receipt.status === "applied") done.push(`removed ${botId}`);
        }
        return ok(
          done.length > 0 ? `Done: ${done.join("; ")}.` : "Nothing changed.",
        );
      } catch (error) {
        return failure("group_update", error);
      }
    },
  };
}

export function createGroupArchiveTool(
  host: GroupChatsRuntimeHostV1,
): ToolDefinition {
  return {
    name: "group_archive",
    namespace: "frockbot",
    description:
      "Archive a group chat you are in when its purpose is done. Its thread stays; your User can restore it. Only your User can delete a group.",
    inputSchema: {
      type: "object",
      properties: { group_id: GROUP_ID_PROPERTY },
      required: ["group_id"],
      additionalProperties: false,
    },
    idempotent: true,
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const groupId = record(input)?.group_id;
      if (!isGroupIdV1(groupId)) {
        return refusal(
          "group_archive was refused: pass a group_id from group_list",
        );
      }
      try {
        const receipt = await host.execute(
          { type: "group/archive", groupId },
          `${context.effectId}:archive`,
        );
        return ok(
          receipt.status === "applied"
            ? "Archived."
            : "It was already archived.",
        );
      } catch (error) {
        return failure("group_archive", error);
      }
    },
  };
}

export function createGroupPostTool(
  host: GroupChatsRuntimeHostV1,
): ToolDefinition {
  return {
    name: "group_post",
    namespace: "frockbot",
    description:
      "Post a message into a group chat you are in, from here. Everyone in the group reads it; write @ and a member's name to ask them something.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: GROUP_ID_PROPERTY,
        text: {
          type: "string",
          minLength: 1,
          maxLength: GROUP_MESSAGE_TEXT_MAX_V1,
        },
      },
      required: ["group_id", "text"],
      additionalProperties: false,
    },
    // The message id comes from the occurrence, so a replay posts once.
    idempotent: true,
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const value = record(input);
      const groupId = value?.group_id;
      const text = typeof value?.text === "string" ? value.text.trim() : "";
      if (!isGroupIdV1(groupId) || !text) {
        return refusal(
          "group_post was refused: pass a group_id from group_list and the text",
        );
      }
      try {
        const message = await host.post(
          groupId,
          text,
          `${context.effectId}:post`,
        );
        return ok(`Posted to the group (message ${message.seq}).`);
      } catch (error) {
        return failure("group_post", error);
      }
    },
  };
}

export const GROUP_CHATS_PROMPT_SECTION_V1 = "groups-membership";

/** The groups this Bot is in, in its own conversation and its Routines. */
export function createGroupChatsPromptSectionV1(
  host: GroupChatsRuntimeHostV1,
): PromptSection {
  return {
    id: GROUP_CHATS_PROMPT_SECTION_V1,
    order: 94,
    render: async (context) => {
      if (context.turnType !== "chat" && context.turnType !== "automation") {
        return "";
      }
      let groups: GroupChatSummaryV1[];
      try {
        groups = (await host.list()).filter(
          (summary) => !summary.group.archivedAt,
        );
      } catch {
        return "";
      }
      if (groups.length === 0) return "";
      return [
        "<group_chats>",
        "You are in these group chats with your User and other Bots. What is said there reaches you when you are asked there; use group_post to post into one from here.",
        ...groups.slice(0, LIST_LIMIT).map(describe),
        "</group_chats>",
      ].join("\n");
    },
  };
}

export function createGroupChatsRuntimeFeature(
  host: GroupChatsRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const ceiling = packageAdmissionCeilingV1(
      groupsDefinitionV1,
      GROUP_MANAGEMENT_CAPABILITY_V1,
    );
    const options = ceiling ? { admissionCeiling: ceiling } : undefined;
    const disposers = [
      runtime.systemPrompt.register(createGroupChatsPromptSectionV1(host)),
      runtime.tools.register(createGroupListTool(host), options),
      runtime.tools.register(createGroupCreateTool(host), options),
      runtime.tools.register(createGroupUpdateTool(host), options),
      runtime.tools.register(createGroupArchiveTool(host), options),
      runtime.tools.register(createGroupPostTool(host), options),
    ];
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}
