// The Group Chats seam a Bot's Turn is handed: the User object for which
// groups exist and who is in them, and each group's own object for posting.
//
// Command and message ids fold in this Turn's run id as well as the tool
// occurrence. An occurrence id is numbered within its Session, and a Bot runs
// Turns in several — its chat, its Routines, its groups — so the occurrence
// alone would let two different calls share one receipt.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import type { BotIdentity } from "@frockbot/core/durable";
import { decodeDirectoryViewV1 } from "@frockbot/app/flock/shared";
import type {
  GroupChatSummaryV1,
  GroupChatsRuntimeHostV1,
} from "@frockbot/app/groups/agent";
import {
  groupChatObjectNameV1,
  unwrapGroupRpcV1,
  type GroupChatListV1,
  type GroupChatReceiptV1,
  type GroupMemberV1,
  type GroupMessageV1,
} from "@frockbot/app/groups/shared";
import type { ShellBotStateV1 } from "./backend-state.js";

interface GroupChatRpc {
  postFromBot(input: unknown): Promise<unknown>;
}

export function createBotGroupChatsHost(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: { runId: string },
): GroupChatsRuntimeHostV1 | undefined {
  const namespace = state.env.GROUP_CHATS;
  if (!namespace) return undefined;
  const user = state.env.USER_CONFIGURATIONS.get(
    state.env.USER_CONFIGURATIONS.idFromName(identity.userId),
  );
  const derive = async (prefix: string, key: string) =>
    `${prefix}-${(
      await sha256HexTextV1(
        `${identity.userId}\u0000${identity.botId}\u0000${turn.runId}\u0000${key}`,
      )
    ).slice(0, 40)}`;
  const directory = async (): Promise<GroupMemberV1[]> =>
    decodeDirectoryViewV1(
      await user.listBots({ schemaVersion: 1, userId: identity.userId }),
    ).bots.map((bot) => {
      const description =
        bot.currentProfile?.description ?? bot.initialDescription;
      return {
        botId: bot.botId,
        name: bot.currentProfile?.name ?? bot.initialName,
        ...(description ? { description } : {}),
      };
    });
  return {
    botId: identity.botId,
    directory,
    async list(): Promise<GroupChatSummaryV1[]> {
      const [list, bots] = await Promise.all([
        user
          .listGroupChats({ schemaVersion: 1, userId: identity.userId })
          .then((answer) => unwrapGroupRpcV1<GroupChatListV1>(answer)),
        directory(),
      ]);
      return list.groups
        .filter((group) => group.members.includes(identity.botId))
        .map((group) => ({
          group,
          members: group.members.map(
            (botId) =>
              bots.find((bot) => bot.botId === botId) ?? { botId, name: botId },
          ),
        }));
    },
    async execute(command, key) {
      return unwrapGroupRpcV1<GroupChatReceiptV1>(
        await user.executeGroupChatCommand({
          schemaVersion: 1,
          userId: identity.userId,
          command: { ...command, commandId: await derive("gb", key) },
          actorBotId: identity.botId,
        }),
      );
    },
    async post(groupId, text, key) {
      // SAFETY: the binding names GroupChat; this is its reviewed RPC door.
      const group = namespace.get(
        namespace.idFromName(groupChatObjectNameV1(identity.userId, groupId)),
      ) as unknown as GroupChatRpc;
      const answer = unwrapGroupRpcV1<{ message: GroupMessageV1 }>(
        await group.postFromBot({
          schemaVersion: 1,
          userId: identity.userId,
          groupId,
          botId: identity.botId,
          messageId: await derive("o", key),
          text,
        }),
      );
      return answer.message;
    },
  };
}
