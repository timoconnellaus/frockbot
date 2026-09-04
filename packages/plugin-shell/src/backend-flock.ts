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
// provider, or a Sprite: identity is Durable Object state, so self-management
// works while the Computer is hibernated and does not wake it.
import type {
  BotSettingsViewV1,
  ConfigurationCommandV1,
  OperationReceiptV1,
} from "@frockbot/configuration-core";
import type {
  BotDirectoryViewV1,
  CreateBotCommandV1,
  FlockReceiptV1,
  FlockSelfRuntimeHostV1,
  BotMessageOutcomeV1,
} from "@frockbot/plugin-flock/agent";
import type { AgentTurnSlotReceiptV1 } from "@frockbot/plugin-flock/quota";

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
    ...(turn.inboundAgent ? { inboundAgent: turn.inboundAgent } : {}),
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
