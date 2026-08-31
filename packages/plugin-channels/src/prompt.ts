// The two prompt sections a Bot in a flock is given, and nothing else.
//
// Register `:463-464`: `ListAgents` and `ListGroups` are **not tools**. A Bot
// learns who its teammates are and what rooms it is in from its prompt, and
// both sections are skipped on automation and subagent turns — a firing is not
// in the conversation and has no business addressing anyone.
//
// Rendering is pure so it can be read in a test without a Durable Object.
import type { BotDirectoryEntryV1 } from "./agent-host.js";
import type { ChannelViewV1 } from "./shared.js";

export const TEAMMATES_SECTION_ID = "channels-teammates";
export const CHANNELS_SECTION_ID = "channels-list";

/** The turn types the two sections are rendered on. */
export function channelPromptAdmittedV1(turnType: string): boolean {
  return turnType === "chat" || turnType === "channel";
}

/**
 * The teammate directory. It names ids, because an id is what `send_to_agent`
 * takes; a name alone would be a directory the Bot cannot act on.
 */
export function renderTeammatesSectionV1(input: {
  selfBotId: string;
  bots: readonly BotDirectoryEntryV1[];
}): string {
  const teammates = input.bots.filter((bot) => bot.botId !== input.selfBotId);
  if (teammates.length === 0) {
    return "<teammates>\nYou are the only Bot in this flock.\n</teammates>";
  }
  const lines = teammates.map((bot) =>
    bot.description === undefined || bot.description.length === 0
      ? `- ${bot.botId}: ${bot.name}`
      : `- ${bot.botId}: ${bot.name} — ${bot.description}`,
  );
  return [
    "<teammates>",
    "The other Bots in your user's flock. Reach one with `send_to_agent`, naming its id.",
    ...lines,
    "</teammates>",
  ].join("\n");
}

/** The rooms this Bot is in, and who else is in them. */
export function renderChannelsSectionV1(input: {
  selfBotId: string;
  channels: readonly ChannelViewV1[];
}): string {
  const live = input.channels.filter((channel) => channel.active);
  if (live.length === 0) {
    return "<channels>\nYou are in no channels yet. `channel_manage` creates one.\n</channels>";
  }
  const lines = live.map((channel) => {
    const others = channel.members.filter(
      (member) => member !== input.selfBotId,
    );
    return `- ${channel.channelId}: "${channel.name}" with ${
      others.length === 0 ? "nobody else yet" : others.join(", ")
    }`;
  });
  return [
    "<channels>",
    "The channels you are a member of. Post to one with `send_to_agent`, naming its id.",
    ...lines,
    "</channels>",
  ].join("\n");
}
