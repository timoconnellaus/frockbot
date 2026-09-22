// Voice opening already holds the User directory from admission. Names come
// from that snapshot. Live activity is a separate read for `list_bots`.

import { createConcurrencyLimiterV1 } from "@frockbot/core/concurrency";
import type {
  BotDirectoryViewV1,
  BotRegistrationV1,
} from "@frockbot/app/flock/shared";
import type { VoiceBotSummaryV1 } from "./assistant.js";

export function directoryBotProfileV1(bot: BotRegistrationV1): {
  name: string;
  description?: string;
} {
  const name = bot.currentProfile?.name ?? bot.initialName;
  const description = bot.currentProfile?.description ?? bot.initialDescription;
  return {
    name,
    ...(description ? { description } : {}),
  };
}

/**
 * The opening directory. The selected Bot keeps the identity admission read.
 * Every other row is the directory projection, with no activity: unknown
 * activity is omitted rather than reported as idle.
 */
export function projectOpeningDirectoryV1(input: {
  directory: BotDirectoryViewV1;
  target: { botId: string; name: string; description?: string };
}): VoiceBotSummaryV1[] {
  return input.directory.bots.map((bot) => {
    if (input.target.botId && bot.botId === input.target.botId) {
      return {
        botId: input.target.botId,
        name: input.target.name,
        ...(input.target.description
          ? { description: input.target.description }
          : {}),
      };
    }
    return { botId: bot.botId, ...directoryBotProfileV1(bot) };
  });
}

/**
 * Explicit `list_bots`. Activity is read with bounded concurrency and omitted
 * when that Bot cannot be read. Directory order is preserved.
 */
export async function listDirectoryActivityV1(
  bots: readonly VoiceBotSummaryV1[],
  readRuns: (botId: string) => Promise<readonly { status: string }[]>,
  limit?: number,
): Promise<VoiceBotSummaryV1[]> {
  const gate = createConcurrencyLimiterV1(limit);
  return Promise.all(
    bots.map((bot) =>
      gate(async () => {
        try {
          const runs = await readRuns(bot.botId);
          const activity = runs.some((run) => run.status === "running")
            ? ("working" as const)
            : ("idle" as const);
          return { ...bot, activity };
        } catch {
          const { activity: _activity, ...rest } = bot;
          return rest;
        }
      }),
    ),
  );
}
