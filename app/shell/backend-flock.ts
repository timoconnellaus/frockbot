// The Bot Durable Object's half of the Bot self-management seam.
//
// The Flock Package offers a Bot self-management and direct messaging over its
// own identity and its User's flock. This module decides, for one admitted
// Turn, what provenance those effects record and which authorities they may
// reach. The profile write is the Bot Durable Object's own configuration
// command, create is the User Durable Object's `bot/create`, and messaging
// admits an agent Turn through the target Bot's Durable Object.
//
// AUTHORITY. "Self-modification never widens authority." The host handed to
// the Package exposes only narrow authority calls. The `botId` on every
// mutation is fixed here rather than taken from the model's arguments. A Bot
// cannot address another Bot's settings through this seam; a message target is
// instead resolved from the same User's Flock directory before admission.
//
// HIBERNATION. Nothing here reaches the Computer registry, a Computer
// provider, or the Computer: identity is Durable Object state, so self-management
// works while the Computer is hibernated and does not wake it.
import type {
  BotSettingsViewV1,
  ConfigurationCommandV1,
  OperationReceiptV1,
} from "@frockbot/core/configuration";
import type {
  BotDirectoryViewV1,
  CreateBotCommandV1,
  FlockReceiptV1,
  FlockSelfRuntimeHostV1,
  BotMessageOutcomeV1,
} from "@frockbot/app/flock/agent";
import type {
  UpdateVoiceCommandV1,
  VoiceIdentityViewV1,
} from "@frockbot/app/flock/shared";
import type { AgentTurnSlotReceiptV1 } from "@frockbot/app/flock/quota";

/** The Bot and User whose identity a Turn may change. */
export interface BotSelfManagementIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a self-management write records. */
export interface BotSelfManagementTurn {
  runId: string;
  turnId: string;
  sessionId: string;
  /** This Turn's pinned profile name, stable across effect recovery. */
  fromBotName: string;
  inboundAgent?: FlockSelfRuntimeHostV1["inboundAgent"];
  /**
   * How many `subagent` hand-offs deep this Turn is, off its own admission
   * record. Absent means none, which is every Turn a person or a Routine
   * started.
   */
  handoffDepth?: number;
}

/**
 * The authorities this seam borrows, supplied by the Durable Object that owns
 * them. Named as its own type so each one is an explicit grant rather than a
 * reach into an environment.
 */
export interface BotSelfManagementAuthorities {
  readSettings(identity: BotSelfManagementIdentity): Promise<BotSettingsViewV1>;
  executeConfiguration(
    identity: BotSelfManagementIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
  ): Promise<OperationReceiptV1>;
  listBots(userId: string): Promise<BotDirectoryViewV1>;
  createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1>;
  readBotVoice(userId: string, botId: string): Promise<VoiceIdentityViewV1>;
  updateBotVoice(
    userId: string,
    botId: string,
    command: UpdateVoiceCommandV1,
  ): Promise<FlockReceiptV1>;
  reserveAgentTurn(request: {
    schemaVersion: 1;
    userId: string;
    requesterId: string;
    runId: string;
    reservedAt: string;
  }): Promise<AgentTurnSlotReceiptV1>;
  releaseAgentTurn(request: {
    schemaVersion: 1;
    userId: string;
    requesterId: string;
    runId: string;
  }): Promise<void>;
  runAgent(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: {
      runId: string;
      sessionId: string;
      acceptedAt: string;
      text: string;
      source: {
        kind: "bot";
        fromBotId: string;
        fromBotName: string;
        messageId: string;
      };
    };
  }): Promise<{ text: string }>;
  /**
   * Admits one Turn on *this* Bot's own agent lane and returns as soon as it
   * has been asked for, never when it finishes: the Turn that called
   * `subagent` is the Turn the hand-off queues behind, so waiting here would
   * wait on itself. Optional — a host with no way to admit its own Turn
   * offers no hand-off tool.
   */
  spawnSubagent?(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: {
      runId: string;
      sessionId: string;
      acceptedAt: string;
      text: string;
      /** An ordinary Turn, on the lane a Bot's delegated work queues on. */
      turnType: "agent";
      lane: "agent";
      origin: { kind: "handoff"; parentRunId: string; depth: number };
    };
  }): Promise<{ status: "started" | "already-started" }>;
}

/**
 * The run id one `subagent` occurrence asks for.
 *
 * Derived from the Bot and the durable tool-call occurrence, exactly as
 * `bot_message`'s is, so a replay after eviction asks for the Turn it already
 * admitted instead of handing the same work off twice.
 */
export async function handoffRunIdV1(
  identity: BotSelfManagementIdentity,
  effectId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${identity.userId}\u0000${identity.botId}\u0000handoff\u0000${effectId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `handoff-${hex.slice(0, 32)}`;
}

async function agentRunIdV1(
  identity: BotSelfManagementIdentity,
  targetBotId: string,
  effectId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${identity.userId}\u0000${identity.botId}\u0000${targetBotId}\u0000${effectId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `agent-${hex.slice(0, 32)}`;
}

/**
 * The self-management seam one admitted Turn runs under. There is no
 * `undefined` case: identity is Durable Object state that is always present,
 * unlike a Workspace surface a host may not have bound.
 */
export function createBotSelfManagementHost(
  identity: BotSelfManagementIdentity,
  turn: BotSelfManagementTurn,
  authorities: BotSelfManagementAuthorities,
): FlockSelfRuntimeHostV1 {
  const owner = { userId: identity.userId, botId: identity.botId };
  return {
    owner,
    // A Bot changes itself only inside a Turn whose Session and Turn its
    // provenance names — the same rule Memory, Skills and Package authoring
    // follow.
    writer: {
      kind: "bot",
      botId: identity.botId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    },
    readSelf: () => authorities.readSettings(identity),
    commandSelf: (command) => {
      // The target is this Bot, decided here. A command aimed anywhere else
      // never reaches an authority.
      if (command.botId !== identity.botId) {
        throw new Error("a Bot may only change its own configuration");
      }
      return authorities.executeConfiguration(identity, command);
    },
    listBots: () => authorities.listBots(identity.userId),
    createBot: (command) => authorities.createBot(identity.userId, command),
    readOwnVoice: async () => {
      const [record, directory] = await Promise.all([
        authorities.readBotVoice(identity.userId, identity.botId),
        authorities.listBots(identity.userId),
      ]);
      // The character is the Bot's own registration, read here so the tool can
      // resolve the default rather than being handed a voice already decided.
      const characterId = directory.bots.find(
        (bot) => bot.botId === identity.botId,
      )?.avatar.characterId;
      return {
        revision: record.revision,
        ...(record.voice ? { voice: record.voice } : {}),
        ...(characterId ? { characterId } : {}),
      };
    },
    updateOwnVoice: (command) => {
      // The target is this Bot, decided here, exactly as `commandSelf` does.
      if (command.botId !== identity.botId) {
        throw new Error("a Bot may only change its own voice");
      }
      return authorities.updateBotVoice(
        identity.userId,
        identity.botId,
        command,
      );
    },
    ...(turn.inboundAgent ? { inboundAgent: turn.inboundAgent } : {}),
    ...(authorities.spawnSubagent
      ? {
          subagent: {
            handoffDepth: turn.handoffDepth ?? 0,
            spawn: async (request) => {
              const runId = await handoffRunIdV1(identity, request.effectId);
              // The depth the hand-off records is this Turn's plus one. The
              // tool refuses above zero, so the only value ever written is 1 —
              // but the arithmetic, not the constant, is what says why.
              const outcome = await authorities.spawnSubagent!({
                schemaVersion: 1,
                userId: identity.userId,
                botId: identity.botId,
                command: {
                  runId,
                  // The Bot's own conversation, so what the hand-off says lands
                  // in the thread the person is already reading.
                  sessionId: turn.sessionId,
                  acceptedAt: new Date().toISOString(),
                  text: request.task,
                  // The lane is the whole reason this is safe to start from
                  // inside a running Turn: it queues behind the conversation
                  // instead of superseding it.
                  turnType: "agent",
                  lane: "agent",
                  origin: {
                    kind: "handoff",
                    parentRunId: turn.runId,
                    depth: (turn.handoffDepth ?? 0) + 1,
                  },
                },
              });
              return { runId, status: outcome.status };
            },
          },
        }
      : {}),
    messageBot: async (request): Promise<BotMessageOutcomeV1> => {
      if (request.targetBotId === identity.botId) {
        throw new Error("a Bot cannot message itself");
      }
      const directory = await authorities.listBots(identity.userId);
      const target = directory.bots.find(
        (bot) => bot.botId === request.targetBotId,
      );
      if (!target)
        throw new Error("the target Bot is not in this User's flock");
      const runId = await agentRunIdV1(
        identity,
        request.targetBotId,
        request.effectId,
      );
      const reservation = await authorities.reserveAgentTurn({
        schemaVersion: 1,
        userId: identity.userId,
        requesterId: identity.botId,
        runId,
        reservedAt: new Date().toISOString(),
      });
      if (reservation.status === "refused") {
        throw new Error(reservation.reason);
      }
      try {
        const turnResult = await authorities.runAgent({
          schemaVersion: 1,
          userId: identity.userId,
          botId: request.targetBotId,
          command: {
            runId,
            sessionId: `${identity.userId}:${request.targetBotId}`,
            acceptedAt: new Date().toISOString(),
            text: request.message,
            source: {
              kind: "bot",
              fromBotId: identity.botId,
              fromBotName: turn.fromBotName,
              messageId: runId,
            },
          },
        });
        return {
          targetBotId: request.targetBotId,
          targetBotName: target.initialName,
          runId,
          text: turnResult.text,
        };
      } finally {
        await authorities.releaseAgentTurn({
          schemaVersion: 1,
          userId: identity.userId,
          requesterId: identity.botId,
          runId,
        });
      }
    },
  };
}
