import type { ClientPluginContext } from "@frockbot/client-core";
import type {
  BotSettingsViewV1,
  ModelBindingV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { FrockBotWebData } from "@frockbot/plugin-shell/shared";
import type { InjectionKey, Ref } from "vue";
import {
  ACCOUNT_MODEL_SETTING_ID_V1,
  BOT_MODEL_SETTING_ID_V1,
} from "../model-settings.js";

export interface CustomModelsClientState {
  setAccountModel(model: ModelBindingV1 | undefined): Promise<void>;
  setBotModel(model: ModelBindingV1 | undefined): Promise<void>;
}

export const customModelsClientStateKey: InjectionKey<CustomModelsClientState> =
  Symbol("frockbot.custom-models.client-state");

type CustomModelsWebData = Pick<
  FrockBotWebData,
  | "activeBotId"
  | "botSettings"
  | "loadBotSettings"
  | "loadUserSettings"
  | "userSettings"
>;

function settingChange(
  settingId: string,
  model: ModelBindingV1 | undefined,
): { values: Record<string, ModelBindingV1> } | { unset: [settingId: string] } {
  return model ? { values: { [settingId]: model } } : { unset: [settingId] };
}

async function rejectRefusal(
  receipt: Awaited<
    ReturnType<
      NonNullable<ClientPluginContext["transport"]["executeConfiguration"]>
    >
  >,
): Promise<void> {
  if (receipt.status === "rejected") throw new Error(receipt.failure);
}

/**
 * Package-local command actions. The User and Bot Durable Objects remain the
 * authorities: each action submits one versioned command and re-reads the
 * projection instead of editing client state optimistically.
 */
export function createCustomModelsClientState(
  transport: ClientPluginContext["transport"],
  web: Ref<CustomModelsWebData>,
): CustomModelsClientState {
  return {
    async setAccountModel(model) {
      const current: UserSettingsViewV1 | undefined = web.value.userSettings;
      if (!current || !transport.executeConfiguration) {
        throw new Error("Model settings are unavailable");
      }
      const receipt = await transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: crypto.randomUUID(),
        expectedRevision: current.revision,
        packageId: "custom-models",
        ...settingChange(ACCOUNT_MODEL_SETTING_ID_V1, model),
      });
      await web.value.loadUserSettings();
      await rejectRefusal(receipt);
    },

    async setBotModel(model) {
      const current: BotSettingsViewV1 | undefined = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !transport.executeConfiguration) {
        throw new Error("Bot model settings are unavailable");
      }
      const receipt = await transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/set-package-settings",
        commandId: crypto.randomUUID(),
        expectedRevision: current.revision,
        botId,
        packageId: "custom-models",
        ...settingChange(BOT_MODEL_SETTING_ID_V1, model),
      });
      await web.value.loadBotSettings();
      await rejectRefusal(receipt);
    },
  };
}
