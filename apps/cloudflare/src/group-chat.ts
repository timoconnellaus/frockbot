// One Group Chat's own Durable Object: its thread, the person's read cursor,
// each member's Turn here, and the clients watching it.
//
// It is addressed as `<userId>:<groupId>` and pins that pair the first time
// the User object creates it, so a request can only ever reach the one group
// it names. Who is in the group is the User object's to say; this object reads
// it before it acts. Member Turns run in the members' own Bot objects: this
// one admits them, reads them back when a member says something changed, and
// reads them again from its alarm while any is open.

import { DurableObject } from "cloudflare:workers";
import {
  GroupChatNotFoundError,
  answerGroupRpcV1,
  unwrapGroupRpcV1,
  decodeGroupPostCommandV1,
  decodeGroupRetryCommandV1,
  decodeGroupStopCommandV1,
  groupChatObjectNameV1,
  groupDisplayNameV1,
  type GroupActorV1,
  type GroupChatContextV1,
  type GroupEventV1,
  type GroupPostCommandV1,
  type GroupRetryCommandV1,
  type GroupStopCommandV1,
} from "@frockbot/app/groups/shared";
import {
  GroupChatLogV1,
  type GroupEffectV1,
  type GroupKvV1,
  type GroupTurnStateV1,
} from "@frockbot/app/groups/log";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import type { GroupReplyJudgeV1 } from "@frockbot/core/contracts";
import { createHostedGroupReplyJudgeV1 } from "@frockbot/app/supervision";
import {
  decodeRpcEnvelopeV1,
  rpcBoolean,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcJsonRecord,
  rpcPattern,
  rpcString,
} from "./durable-rpc.js";

export const GROUP_CHANNEL_INTERNAL_PATH = "/internal/group-channel";

/** How often an open member Turn is read back when no nudge has arrived. */
const OPEN_TURN_POLL_MS = 30_000;
/** How long an owed admission waits before it is asked for again. */
const ADMISSION_RETRY_MS = 15_000;

export interface GroupChatEnv {
  BOT_STATES: DurableObjectNamespace;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  GROUP_CHATS: DurableObjectNamespace;
  /** Jev, who judges who answers each message. Absent, nobody extra is asked. */
  JEV_API_KEY?: string;
}

/** How long one judgment may take before the group goes on without it. */
const JUDGEMENT_TIMEOUT_MS = 45_000;

interface BotGroupRpc {
  admitGroupTurn(input: unknown): Promise<unknown>;
  readGroupTurn(input: unknown): Promise<unknown>;
  signalGroupMessage(input: unknown): Promise<unknown>;
  stopRun(input: unknown): Promise<unknown>;
}

interface UserGroupRpc {
  readGroupChatContext(input: unknown): Promise<unknown>;
  deliverGroupPush(input: unknown): Promise<unknown>;
}

const groupIdDecoder = rpcPattern(/^g-[0-9a-f]{20}$/, 22);

function errorNamed(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

export class GroupChat extends DurableObject<GroupChatEnv> {
  private judgeInstance?: GroupReplyJudgeV1;

  /** Jev when this deployment has it; the unavailable judge otherwise. */
  private judge(): GroupReplyJudgeV1 {
    this.judgeInstance ??= createHostedGroupReplyJudgeV1({
      JEV_API_KEY: this.env.JEV_API_KEY,
    });
    return this.judgeInstance;
  }

  private log(kv: GroupKvV1 = this.ctx.storage as unknown as GroupKvV1) {
    return new GroupChatLogV1(kv);
  }

  private transaction<T>(closure: (log: GroupChatLogV1) => Promise<T>) {
    return this.ctx.storage.transaction((transaction) =>
      closure(this.log(transaction as unknown as GroupKvV1)),
    );
  }

  /** The caller named this object: its namespace name is the User and group. */
  private assertAddressed(userId: string, groupId: string): void {
    const id = this.env.GROUP_CHATS.idFromName(
      groupChatObjectNameV1(userId, groupId),
    );
    if (!id.equals(this.ctx.id)) {
      throw new Error("this Group Chat object is a different group");
    }
  }

  /** Addressed, pinned, and pinned to the same pair. */
  private async assertIdentity(userId: string, groupId: string): Promise<void> {
    this.assertAddressed(userId, groupId);
    const identity = await this.log().identity();
    if (!identity) throw new GroupChatNotFoundError(groupId);
    if (identity.userId !== userId || identity.groupId !== groupId) {
      throw new Error("this Group Chat object is a different group");
    }
  }

  private botStub(userId: string, botId: string): BotGroupRpc {
    return this.env.BOT_STATES.get(
      this.env.BOT_STATES.idFromName(`${userId}:${botId}`),
    ) as unknown as BotGroupRpc;
  }

  /** The group and its members' names, as the User object has them now. */
  private async context(
    userId: string,
    groupId: string,
  ): Promise<GroupChatContextV1> {
    const user = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(userId),
    ) as unknown as UserGroupRpc;
    return unwrapGroupRpcV1<GroupChatContextV1>(
      await user.readGroupChatContext({ schemaVersion: 1, userId, groupId }),
    );
  }

  // ---- from the User object ---------------------------------------------

  /** A change the User object committed: the line it adds to the thread. */
  async recordEvent(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        commandId: rpcString(256),
        actor: rpcJsonRecord,
        event: rpcJsonRecord,
        context: rpcJsonRecord,
      },
      { initialize: rpcBoolean },
    );
    const userId = request.userId as string;
    const groupId = request.groupId as string;
    this.assertAddressed(userId, groupId);
    if (request.initialize === true) {
      await this.log().initialize({ schemaVersion: 1, userId, groupId });
    }
    await this.assertIdentity(userId, groupId);
    const outcome = await this.transaction((log) =>
      log.recordEvent({
        commandId: request.commandId as string,
        actor: request.actor as unknown as GroupActorV1,
        event: request.event as unknown as GroupEventV1,
        context: request.context as unknown as GroupChatContextV1,
      }),
    );
    await this.carryOut(userId, outcome.effects);
    return { schemaVersion: 1, seq: outcome.value.seq } as const;
  }

  /** The User deleted the group: its member Turns stop and its thread goes. */
  async destroy(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      groupId: groupIdDecoder,
    });
    const userId = request.userId as string;
    const groupId = request.groupId as string;
    this.assertAddressed(userId, groupId);
    if (!(await this.log().identity())) {
      return { schemaVersion: 1 } as const;
    }
    await this.assertIdentity(userId, groupId);
    for (const turn of await this.log().openTurns()) {
      await this.stopMember(
        userId,
        turn.botId,
        turn.runId,
        `delete-${groupId}`,
      );
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, "group deleted");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { schemaVersion: 1 } as const;
  }

  // ---- from the client, through the gateway -----------------------------

  async view(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
      });
      const userId = request.userId as string;
      const groupId = request.groupId as string;
      await this.assertIdentity(userId, groupId);
      return this.log().view(await this.context(userId, groupId));
    });
  }

  async page(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(
        input,
        {
          userId: rpcIdentifier,
          groupId: groupIdDecoder,
          limit: rpcInteger({ minimum: 1, maximum: 100 }),
        },
        {
          before: rpcInteger({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          after: rpcInteger({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
      );
      await this.assertIdentity(
        request.userId as string,
        request.groupId as string,
      );
      return this.log().page({
        limit: request.limit as number,
        ...(request.before !== undefined
          ? { before: request.before as number }
          : {}),
        ...(request.after !== undefined
          ? { after: request.after as number }
          : {}),
      });
    });
  }

  /** The person said something in the group. */
  async postFromUser(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        command: rpcDecoded(decodeGroupPostCommandV1),
      });
      const userId = request.userId as string;
      const groupId = request.groupId as string;
      await this.assertIdentity(userId, groupId);
      const command = request.command as unknown as GroupPostCommandV1;
      const context = await this.context(userId, groupId);
      const outcome = await this.transaction((log) =>
        log.post({
          messageId: `u-${command.commandId}`,
          author: { kind: "user" },
          text: command.text,
          context,
        }),
      );
      await this.carryOut(userId, outcome.effects);
      return { schemaVersion: 1, message: outcome.value } as const;
    });
  }

  /**
   * A member posting into the group from outside it — its own chat, or a
   * Routine. The message id is the Bot's, derived from the call that posted,
   * so a replayed call posts once.
   */
  async postFromBot(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        botId: rpcBotId,
        messageId: rpcPattern(/^o-[0-9a-f]{40}$/, 42),
        text: rpcDecoded(
          (value) =>
            decodeGroupPostCommandV1({
              schemaVersion: 1,
              commandId: "outside",
              text: value,
            }).text,
        ),
      });
      const userId = request.userId as string;
      const groupId = request.groupId as string;
      await this.assertIdentity(userId, groupId);
      const context = await this.context(userId, groupId);
      const outcome = await this.transaction((log) =>
        log.post({
          messageId: request.messageId as string,
          author: { kind: "bot", botId: request.botId as string },
          text: request.text as string,
          context,
        }),
      );
      await this.carryOut(userId, outcome.effects);
      return { schemaVersion: 1, message: outcome.value } as const;
    });
  }

  async markRead(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        upTo: rpcInteger({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      });
      await this.assertIdentity(
        request.userId as string,
        request.groupId as string,
      );
      const readThrough = await this.transaction((log) =>
        log.markRead(request.upTo as number),
      );
      this.broadcast();
      return { schemaVersion: 1, readThrough } as const;
    });
  }

  /** `/stop`: the group's member Turns, or one member's. */
  async stop(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        command: rpcDecoded(decodeGroupStopCommandV1),
      });
      const userId = request.userId as string;
      const groupId = request.groupId as string;
      await this.assertIdentity(userId, groupId);
      const command = request.command as unknown as GroupStopCommandV1;
      const outcome = await this.transaction((log) =>
        log.stop({
          commandId: command.commandId,
          ...(command.botId ? { botId: command.botId } : {}),
        }),
      );
      await this.carryOut(userId, outcome.effects);
      return { schemaVersion: 1, stopped: outcome.value.stopped } as const;
    });
  }

  async retry(input: unknown) {
    return answerGroupRpcV1(async () => {
      const request = decodeRpcEnvelopeV1(input, {
        userId: rpcIdentifier,
        groupId: groupIdDecoder,
        command: rpcDecoded(decodeGroupRetryCommandV1),
      });
      const userId = request.userId as string;
      const groupId = request.groupId as string;
      await this.assertIdentity(userId, groupId);
      const command = request.command as unknown as GroupRetryCommandV1;
      const context = await this.context(userId, groupId);
      const outcome = await this.transaction((log) =>
        log.retry({ ...command, context }),
      );
      await this.carryOut(userId, outcome.effects);
      return { schemaVersion: 1 } as const;
    });
  }

  // ---- from a member's Bot object ---------------------------------------

  /** A member Turn changed; read it back. */
  async turnChanged(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      groupId: groupIdDecoder,
      botId: rpcBotId,
      runId: rpcString(128),
    });
    const userId = request.userId as string;
    const groupId = request.groupId as string;
    await this.assertIdentity(userId, groupId);
    await this.readBack(
      userId,
      groupId,
      request.botId as string,
      request.runId as string,
    );
    return { schemaVersion: 1 } as const;
  }

  private async readBack(
    userId: string,
    groupId: string,
    botId: string,
    runId: string,
    context?: GroupChatContextV1,
  ): Promise<void> {
    const read = (await this.botStub(userId, botId).readGroupTurn({
      schemaVersion: 1,
      userId,
      botId,
      runId,
    })) as { found: boolean; state?: GroupTurnStateV1 };
    const state: GroupTurnStateV1 =
      read.found && read.state
        ? structuredClone(read.state)
        : // The member no longer has the run: count it as ended.
          { status: "failed", started: true, sends: [], yielded: false };
    const resolved = context ?? (await this.context(userId, groupId));
    const outcome = await this.transaction((log) =>
      log.applyTurnState({ botId, runId, state, context: resolved }),
    );
    await this.carryOut(userId, outcome.effects);
  }

  // ---- effects and the alarm ---------------------------------------------

  /** What a committed change owes the outside world, after the commit. */
  private async carryOut(
    userId: string,
    effects: readonly GroupEffectV1[],
  ): Promise<void> {
    let broadcast = false;
    const identity = await this.log().identity();
    const judged: number[] = [];
    let pushed = false;
    for (const effect of effects) {
      switch (effect.kind) {
        case "broadcast":
          broadcast = true;
          break;
        case "judge":
          judged.push(effect.seq);
          break;
        case "push":
          pushed = true;
          break;
        case "signal":
          if (!identity) break;
          await this.botStub(userId, effect.botId)
            .signalGroupMessage({
              schemaVersion: 1,
              userId,
              botId: effect.botId,
              groupId: identity.groupId,
              seq: effect.seq,
            })
            .catch(() => undefined);
          break;
        case "stop":
          await this.stopMember(
            userId,
            effect.botId,
            effect.runId,
            effect.commandId,
          );
          break;
        case "admit":
          try {
            await this.botStub(userId, effect.botId).admitGroupTurn({
              schemaVersion: 1,
              userId,
              botId: effect.botId,
              command: effect.admission,
            });
            await this.transaction((log) =>
              log.admitted(effect.botId, effect.admission.runId),
            );
            broadcast = true;
          } catch {
            // Written down already; the alarm asks again, until the member
            // has refused often enough that the group shows it did not
            // answer and offers Retry.
            const gaveUp = await this.transaction((log) =>
              log.admissionFailed(effect.botId, effect.admission.runId),
            );
            if (gaveUp) broadcast = true;
          }
          break;
      }
    }
    if (broadcast) this.broadcast();
    if (identity && pushed) {
      await this.deliverPushes(userId, identity.groupId);
    }
    if (identity) {
      for (const seq of judged) {
        await this.judgeMessage(userId, identity.groupId, seq);
      }
    }
    await this.armAlarm();
  }

  /**
   * Notifies the person of every member message that calls them. A device
   * reading this group defers the alert, and a failure keeps it: the alarm
   * tries again until it is delivered.
   */
  private async deliverPushes(userId: string, groupId: string): Promise<void> {
    const log = this.log();
    const pending = await log.pendingPushes();
    if (pending.length === 0) return;
    const context = await this.context(userId, groupId).catch(() => undefined);
    if (!context) return;
    const user = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(userId),
    ) as unknown as UserGroupRpc;
    const title = groupDisplayNameV1(context.group, context.members);
    for (const seq of pending) {
      const message = await log.message(seq);
      // Read per entry: the person may read the group during a delivery.
      const { readThrough } = await log.channelState();
      if (
        seq <= readThrough ||
        message?.body.kind !== "text" ||
        message.author.kind !== "bot"
      ) {
        await this.transaction((next) => next.pushDelivered(seq));
        continue;
      }
      const authorId = message.author.botId;
      const author =
        context.members.find((member) => member.botId === authorId)?.name ??
        authorId;
      try {
        await user.deliverGroupPush({
          schemaVersion: 1,
          userId,
          groupId,
          botId: authorId,
          seq,
          title: title.slice(0, 200),
          body: `${author}: ${message.body.text}`.slice(0, 240),
        });
      } catch {
        // Still owed; the alarm tries again.
        return;
      }
      await this.transaction((next) => next.pushDelivered(seq));
    }
  }

  /**
   * Asks Jev who answers one message, and applies the answer once. A
   * judgment that fails is still written down as owed, and the alarm asks
   * again.
   */
  private async judgeMessage(
    userId: string,
    groupId: string,
    seq: number,
    known?: GroupChatContextV1,
  ): Promise<void> {
    const context = known ?? (await this.context(userId, groupId));
    const evidence = await this.log().judgementEvidence(seq, context);
    const decision = evidence
      ? await this.judge()
          .decide(evidence, AbortSignal.timeout(JUDGEMENT_TIMEOUT_MS))
          .catch(() => undefined)
      : { reply: [] };
    if (!decision) return;
    const outcome = await this.transaction((log) =>
      log.applyJudgement({ seq, decision, context }),
    );
    await this.carryOut(userId, outcome.effects);
  }

  private async stopMember(
    userId: string,
    botId: string,
    runId: string,
    commandId: string,
  ): Promise<void> {
    const digest = await sha256HexTextV1(`${commandId}\n${botId}\n${runId}`);
    await this.botStub(userId, botId)
      .stopRun({
        schemaVersion: 1,
        userId,
        botId,
        command: {
          schemaVersion: 1,
          action: "stop",
          commandId: `gs-${digest.slice(0, 32)}`,
          runId,
        },
      })
      .catch(() => undefined);
  }

  private async armAlarm(): Promise<void> {
    const log = this.log();
    const open = (await log.openTurns()).length > 0;
    const owed =
      (await log.owedAdmissions()).length > 0 ||
      (await log.pendingJudgements()).length > 0 ||
      (await log.pendingPushes()).length > 0;
    if (!open && !owed) return;
    const due = Date.now() + (owed ? ADMISSION_RETRY_MS : OPEN_TURN_POLL_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) {
      await this.ctx.storage.setAlarm(due);
    }
  }

  async alarm(): Promise<void> {
    const identity = await this.log().identity();
    if (!identity) return;
    let context: GroupChatContextV1;
    try {
      context = await this.context(identity.userId, identity.groupId);
    } catch (error) {
      if (errorNamed(error, "GroupChatNotFoundError")) {
        // The User deleted the group and the delete did not reach this
        // object; finish it here.
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + ADMISSION_RETRY_MS);
      return;
    }
    for (const turn of await this.log().openTurns()) {
      await this.readBack(
        identity.userId,
        identity.groupId,
        turn.botId,
        turn.runId,
        context,
      ).catch(() => undefined);
    }
    await this.deliverPushes(identity.userId, identity.groupId).catch(
      () => undefined,
    );
    for (const seq of await this.log().pendingJudgements()) {
      await this.judgeMessage(
        identity.userId,
        identity.groupId,
        seq,
        context,
      ).catch(() => undefined);
    }
    const due = await this.transaction((log) => log.admissionsDue(context));
    await this.carryOut(identity.userId, due);
  }

  // ---- the client channel -------------------------------------------------

  /**
   * A small state frame on every change: where the thread's head is, what the
   * person has read, and who is working. A client reads the messages it has
   * not seen through the ordinary page route.
   */
  private async stateFrame(): Promise<string> {
    const log = this.log();
    const state = await log.channelState();
    return JSON.stringify({ schemaVersion: 1, type: "group/state", ...state });
  }

  private broadcast(): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    this.ctx.waitUntil(
      (async () => {
        const frame = await this.stateFrame();
        for (const socket of sockets) {
          try {
            socket.send(frame);
          } catch {
            // Closed; the runtime drops it.
          }
        }
      })(),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== GROUP_CHANNEL_INTERNAL_PATH) {
      return new Response("not found", { status: 404 });
    }
    const userId = request.headers.get("x-frockbot-user-id") ?? "";
    const groupId = request.headers.get("x-frockbot-group-id") ?? "";
    try {
      await this.assertIdentity(userId, groupId);
    } catch (error) {
      if (errorNamed(error, "GroupChatNotFoundError")) {
        return Response.json(
          { error: "Group Chat not found" },
          { status: 404 },
        );
      }
      throw error;
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["group"]);
    server.send(await this.stateFrame());
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(): void {
    // The channel carries state to the client; nothing is read from it.
  }

  webSocketClose(socket: WebSocket, code: number): void {
    try {
      socket.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // Already closed.
    }
  }
}
