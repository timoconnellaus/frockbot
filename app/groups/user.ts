// The User object's half of Group Chats: which groups exist, who is in them,
// and where each sits in the sidebar.
//
// Membership lives here because Memory already asks this object who may read
// a group's memory. Every change is one command with a durable receipt; the
// line it adds to the thread is carried to the group's own object after the
// commit, and a replayed command carries it again, which that object writes
// once.

import { canonicalJson } from "@frockbot/core/contracts";
import {
  GROUP_CHAT_LIMIT_V1,
  GROUP_CHAT_MEMBERS_MAX_V1,
  GROUP_CHAT_MEMBERS_MIN_V1,
  GroupChatConflictError,
  GroupChatNotFoundError,
  groupIdForCommandV1,
  type GroupActorV1,
  type GroupChatCommandV1,
  type GroupChatContextV1,
  type GroupChatListV1,
  type GroupChatReceiptV1,
  type GroupChatRecordV1,
  type GroupEventV1,
  type GroupMemberV1,
} from "./shared.js";

const LIST_KEY = "group-chat:list:v1";
const RECEIPT_PREFIX = "group-chat:receipt:";

export interface GroupChatUserKvV1 {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface GroupChatUserStorageV1 extends GroupChatUserKvV1 {
  transaction<T>(
    closure: (transaction: GroupChatUserKvV1) => Promise<T>,
  ): Promise<T>;
}

/** What the group's own object has to be told after a command commits. */
export type GroupChatChangeV1 =
  | {
      kind: "event";
      commandId: string;
      actor: GroupActorV1;
      event: GroupEventV1;
      context: GroupChatContextV1;
      /** The object is new: pin it before writing the line. */
      initialize?: true;
    }
  | { kind: "delete"; groupId: string };

export interface GroupChatCommandResultV1 {
  receipt: GroupChatReceiptV1;
  change?: GroupChatChangeV1;
}

interface StoredReceiptV1 {
  schemaVersion: 1;
  fingerprint: string;
  result: GroupChatCommandResultV1;
}

function emptyList(): GroupChatListV1 {
  return { schemaVersion: 1, revision: 0, groups: [] };
}

export class GroupChatUserStoreV1 {
  constructor(
    private readonly storage: GroupChatUserStorageV1,
    /** The Bots the User has, with the names the directory shows now. */
    private readonly directory: () => Promise<GroupMemberV1[]>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<GroupChatListV1> {
    return structuredClone(
      (await this.storage.get<GroupChatListV1>(LIST_KEY)) ?? emptyList(),
    );
  }

  /** The group and its members' names, as its own object needs them. */
  async context(groupId: string): Promise<GroupChatContextV1> {
    const group = (await this.list()).groups.find(
      (candidate) => candidate.groupId === groupId,
    );
    if (!group) throw new GroupChatNotFoundError(groupId);
    return this.contextOf(group, await this.directory());
  }

  private contextOf(
    group: GroupChatRecordV1,
    directory: readonly GroupMemberV1[],
  ): GroupChatContextV1 {
    return {
      schemaVersion: 1,
      group,
      members: group.members.map(
        (botId) =>
          directory.find((bot) => bot.botId === botId) ?? {
            botId,
            name: botId,
          },
      ),
    };
  }

  /** The groups a Bot is a member of, for Memory's authority check. */
  async groupsOf(botId: string): Promise<string[]> {
    return (await this.list()).groups
      .filter((group) => group.members.includes(botId))
      .map((group) => group.groupId);
  }

  async execute(
    userId: string,
    command: GroupChatCommandV1,
    actor: GroupActorV1,
  ): Promise<GroupChatCommandResultV1> {
    const directory = await this.directory();
    const fingerprint = canonicalJson({ command, actor });
    const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
    const groupId =
      command.type === "group/create"
        ? await groupIdForCommandV1(userId, command.commandId)
        : command.groupId;
    return this.storage.transaction(async (transaction) => {
      const replay = await transaction.get<StoredReceiptV1>(receiptKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new GroupChatConflictError(
            `command "${command.commandId}" was already used for a different command`,
          );
        }
        return replay.result;
      }
      const list =
        (await transaction.get<GroupChatListV1>(LIST_KEY)) ?? emptyList();
      const result = this.apply(list, groupId, command, actor, directory);
      if (result.changed) {
        list.revision += 1;
        await transaction.put(LIST_KEY, list);
      }
      const stored: StoredReceiptV1 = {
        schemaVersion: 1,
        fingerprint,
        result: {
          receipt: {
            schemaVersion: 1,
            commandId: command.commandId,
            groupId,
            status: result.changed ? "applied" : "unchanged",
            ...(result.group ? { group: result.group } : {}),
            revision: list.revision,
          },
          ...(result.change ? { change: result.change } : {}),
        },
      };
      await transaction.put(receiptKey, stored);
      return structuredClone(stored.result);
    });
  }

  private apply(
    list: GroupChatListV1,
    groupId: string,
    command: GroupChatCommandV1,
    actor: GroupActorV1,
    directory: readonly GroupMemberV1[],
  ): {
    changed: boolean;
    group?: GroupChatRecordV1;
    change?: GroupChatChangeV1;
  } {
    const at = this.now().toISOString();
    const registered = (botId: string) =>
      directory.some((bot) => bot.botId === botId);
    const event = (
      group: GroupChatRecordV1,
      value: GroupEventV1,
      initialize = false,
    ): GroupChatChangeV1 => ({
      kind: "event",
      commandId: command.commandId,
      actor,
      event: value,
      context: this.contextOf(group, directory),
      ...(initialize ? { initialize: true as const } : {}),
    });
    if (command.type === "group/create") {
      if (list.groups.length >= GROUP_CHAT_LIMIT_V1) {
        throw new GroupChatConflictError(
          `an account has at most ${GROUP_CHAT_LIMIT_V1} Group Chats`,
        );
      }
      const unknown = command.members.find((botId) => !registered(botId));
      if (unknown) {
        throw new GroupChatConflictError(
          `"${unknown}" is not one of your Bots`,
        );
      }
      if (actor.kind === "bot" && !command.members.includes(actor.botId)) {
        throw new GroupChatConflictError(
          "a Bot may only start a Group Chat it is in",
        );
      }
      const group: GroupChatRecordV1 = {
        schemaVersion: 1,
        groupId,
        ...(command.name ? { name: command.name } : {}),
        members: [...command.members],
        createdAt: at,
        updatedAt: at,
      };
      list.groups.push(group);
      return {
        changed: true,
        group,
        change: event(
          group,
          {
            type: "created",
            members: [...command.members],
            ...(command.name ? { name: command.name } : {}),
          },
          true,
        ),
      };
    }
    const index = list.groups.findIndex((group) => group.groupId === groupId);
    if (index < 0) throw new GroupChatNotFoundError(groupId);
    const group = list.groups[index]!;
    if (actor.kind === "bot") {
      if (!group.members.includes(actor.botId)) {
        throw new GroupChatConflictError(
          "only a member may change this Group Chat",
        );
      }
      if (
        command.type === "group/delete" ||
        command.type === "group/restore" ||
        command.type === "group/arrange"
      ) {
        throw new GroupChatConflictError("only the User may do that");
      }
    }
    const touch = () => {
      group.updatedAt = at;
    };
    switch (command.type) {
      case "group/rename": {
        if ((group.name ?? null) === command.name)
          return { changed: false, group };
        if (command.name) group.name = command.name;
        else delete group.name;
        touch();
        return {
          changed: true,
          group,
          change: event(group, { type: "renamed", name: command.name }),
        };
      }
      case "group/add-member": {
        if (group.members.includes(command.botId))
          return { changed: false, group };
        if (!registered(command.botId)) {
          throw new GroupChatConflictError(
            `"${command.botId}" is not one of your Bots`,
          );
        }
        if (group.members.length >= GROUP_CHAT_MEMBERS_MAX_V1) {
          throw new GroupChatConflictError(
            `a Group Chat has at most ${GROUP_CHAT_MEMBERS_MAX_V1} Bots`,
          );
        }
        group.members.push(command.botId);
        touch();
        return {
          changed: true,
          group,
          change: event(group, { type: "member-added", botId: command.botId }),
        };
      }
      case "group/remove-member": {
        if (!group.members.includes(command.botId))
          return { changed: false, group };
        if (group.members.length <= GROUP_CHAT_MEMBERS_MIN_V1) {
          throw new GroupChatConflictError(
            `a Group Chat has at least ${GROUP_CHAT_MEMBERS_MIN_V1} Bots`,
          );
        }
        group.members = group.members.filter(
          (botId) => botId !== command.botId,
        );
        touch();
        return {
          changed: true,
          group,
          change: event(group, {
            type: "member-removed",
            botId: command.botId,
          }),
        };
      }
      case "group/archive": {
        if (group.archivedAt) return { changed: false, group };
        group.archivedAt = at;
        touch();
        return {
          changed: true,
          group,
          change: event(group, { type: "archived" }),
        };
      }
      case "group/restore": {
        if (!group.archivedAt) return { changed: false, group };
        delete group.archivedAt;
        touch();
        return {
          changed: true,
          group,
          change: event(group, { type: "restored" }),
        };
      }
      case "group/delete": {
        list.groups.splice(index, 1);
        return { changed: true, change: { kind: "delete", groupId } };
      }
      case "group/arrange": {
        const before = canonicalJson(group);
        if (command.label !== undefined) {
          if (command.label) group.label = command.label;
          else delete group.label;
        }
        if (command.pinned !== undefined) {
          if (command.pinned) group.pinnedAt ??= at;
          else delete group.pinnedAt;
        }
        if (command.sidebarOrder !== undefined) {
          if (command.sidebarOrder === null) delete group.sidebarOrder;
          else group.sidebarOrder = command.sidebarOrder;
        }
        if (command.hidden !== undefined) {
          if (command.hidden) group.hiddenFromSidebar = true;
          else delete group.hiddenFromSidebar;
        }
        return { changed: canonicalJson(group) !== before, group };
      }
    }
  }

  /**
   * A deleted Bot leaves every group it was in, even one that drops below
   * two members; the User decides what happens to that group.
   */
  async forgetBot(botId: string): Promise<GroupChatChangeV1[]> {
    const directory = await this.directory();
    return this.storage.transaction(async (transaction) => {
      const list =
        (await transaction.get<GroupChatListV1>(LIST_KEY)) ?? emptyList();
      const changes: GroupChatChangeV1[] = [];
      for (const group of list.groups) {
        if (!group.members.includes(botId)) continue;
        group.members = group.members.filter((member) => member !== botId);
        group.updatedAt = this.now().toISOString();
        changes.push({
          kind: "event",
          commandId: `bot-deleted-${botId}`,
          actor: { kind: "user" },
          event: { type: "member-removed", botId },
          context: this.contextOf(group, directory),
        });
      }
      if (changes.length > 0) {
        list.revision += 1;
        await transaction.put(LIST_KEY, list);
      }
      return changes;
    });
  }
}
