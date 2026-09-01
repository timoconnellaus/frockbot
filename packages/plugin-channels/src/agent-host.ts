// The host seam the Channels runtime Contribution receives.
//
// The Package holds the records, the codecs and the command semantics; what it
// cannot own is the User Durable Object that stores them and the Turn that
// attributes a write. The Bot Durable Object supplies both, for one admitted
// Turn, through this interface.
//
// Declared in its own module so the host that builds it — the Bot Durable
// Object's Shell Contribution — does not have to import the tool definitions,
// the cordis plugin, or anything else the Agent runtime needs.
import type { TurnTypeV1 } from "@frockbot/kernel-contracts";
import type {
  ChannelCommandReceiptV1,
  ChannelCommandV1,
  ChannelListViewV1,
} from "./shared.js";
import type { ChannelWriterV1 } from "./records.js";

/** The Session and Turn a Bot-authored Channel write records as its writer. */
export interface ChannelWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/** One teammate, as the prompt directory names it. */
export interface BotDirectoryEntryV1 {
  botId: string;
  name: string;
  description?: string;
}

export interface ChannelsRuntimeHostV1 {
  botId: string;
  /** Absent outside a Turn; the tools are then not registered at all. */
  writer?: ChannelWriterIdentityV1;
  /** The turn type this Turn was admitted as. Absent is `chat`. */
  turnType?: TurnTypeV1;
  /** The Channel this Turn is a reply inside, when it is a `channel` Turn. */
  origin?: { channelId: string; hop: number };
  list(): Promise<ChannelListViewV1>;
  directory(): Promise<BotDirectoryEntryV1[]>;
  execute(
    command: ChannelCommandV1,
    writer: ChannelWriterV1,
  ): Promise<ChannelCommandReceiptV1>;
}
