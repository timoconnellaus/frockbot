// The Bot Durable Object's half of the Bot self-management seam.
//
// The Flock Package offers a Bot two tools over its own identity and its
// User's flock. This module decides, for one admitted Turn, what provenance
// those writes record and which authorities they may reach. It implements
// neither: the profile write is the Bot Durable Object's own configuration
// command, and the create is the User Durable Object's `bot/create` — the
// same two paths the hosted client drives.
//
// AUTHORITY. "Self-modification never widens authority." The host handed to
// the Package exposes exactly four calls, all of them things the User's own
// surfaces already do, and the `botId` on every one of them is fixed here
// rather than taken from the model's arguments. A Bot cannot address another
// Bot's settings through this seam because the seam never accepts a target.
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
} from "@frockbot/plugin-flock/agent";

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
  };
}
