import {
  decodeBotSettingsViewV1,
  migrateStoredBotSettingsV1,
  type BotSettingsViewV1,
} from "@frockbot/core/configuration";
import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";

/** The Bot Durable Object key holding this Bot's durable configuration. */
export const BOT_CONFIGURATION_KEY = "bot-configuration";

/** This Bot's settings as stored. A Bot that was never materialized has none. */
export async function readBotSettingsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<BotSettingsViewV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.get<unknown>(BOT_CONFIGURATION_KEY);
  if (stored === undefined)
    throw new Error(`Bot "${identity.botId}" is not materialized`);
  return decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
}
