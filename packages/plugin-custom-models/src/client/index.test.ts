import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import {
  decodeConfigurationCommandV1,
  initializeBotSettingsV1,
  type ConfigurationCommandV1,
  type ModelBindingV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
} from "@frockbot/plugin-shell/shared";
import { ref, type Ref } from "vue";
import {
  customModelsClientPlugin,
  customModelsClientStateKey,
  type CustomModelsClientState,
} from "./index.js";

function fixture(accountModel?: ModelBindingV1): {
  slots: ClientSlotRegistration[];
  commands: ConfigurationCommandV1[];
  state: CustomModelsClientState;
  userLoads(): number;
  botLoads(): number;
  dispose(): void;
} {
  const slots: ClientSlotRegistration[] = [];
  const commands: ConfigurationCommandV1[] = [];
  const user: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 3,
    profile: { name: "User" },
    packages: [
      {
        packageId: "custom-models",
        version: "0.0.1",
        state: "installed",
        ...(accountModel ? { values: { "account-model": accountModel } } : {}),
      },
    ],
    connections: [],
  };
  const bot = initializeBotSettingsV1("scout");
  let userLoadCount = 0;
  let botLoadCount = 0;
  const web = ref({
    activeBotId: bot.botId,
    botSettings: bot,
    userSettings: user,
    loadUserSettings: () => {
      userLoadCount += 1;
      return Promise.resolve();
    },
    loadBotSettings: () => {
      botLoadCount += 1;
      return Promise.resolve();
    },
  }) as unknown as Ref<FrockBotWebData>;
  let state: CustomModelsClientState | undefined;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      executeConfiguration: (input) => {
        const command = decodeConfigurationCommandV1(input);
        commands.push(command);
        return Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          revision: command.expectedRevision + 1,
          status: "applied",
        });
      },
    },
    inject: ((key: unknown) => {
      if (key === frockBotWebDataKey) return web;
      throw new Error("unexpected client provider");
    }) as ClientPluginContext["inject"],
    provide: ((key: unknown, value: unknown) => {
      if (key === customModelsClientStateKey) {
        state = value as CustomModelsClientState;
      }
      return () => {};
    }) as ClientPluginContext["provide"],
    slot: (registration) => {
      slots.push(registration);
      return () => slots.splice(slots.indexOf(registration), 1);
    },
  };
  const result = customModelsClientPlugin(context);
  if (result instanceof Promise) throw new Error("expected synchronous plugin");
  if (!state) throw new Error("Custom models state was not provided");
  return {
    slots,
    commands,
    state,
    userLoads: () => userLoadCount,
    botLoads: () => botLoadCount,
    dispose: () => {
      if (Array.isArray(result)) {
        for (const dispose of result.toReversed()) dispose();
      } else if (typeof result === "function") {
        result();
      }
    },
  };
}

describe("Custom models client Contribution", () => {
  test("mounts the account and Bot model sections", () => {
    const mounted = fixture();
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.models-sections",
      "frockbot.bot-settings-sections",
    ]);
    mounted.dispose();
  });

  test("round-trips selections and clears through User and Bot Package-setting commands", async () => {
    const mounted = fixture();
    const model: ModelBindingV1 = {
      connectionId: "flock-ai",
      providerModelId: "@frock/manual",
    };

    await mounted.state.setAccountModel(model);
    await mounted.state.setAccountModel(undefined);
    await mounted.state.setBotModel(model);
    await mounted.state.setBotModel(undefined);

    expect(mounted.commands).toMatchObject([
      {
        type: "user/set-package-settings",
        packageId: "custom-models",
        values: { "account-model": model },
      },
      {
        type: "user/set-package-settings",
        packageId: "custom-models",
        unset: ["account-model"],
      },
      {
        type: "bot/set-package-settings",
        botId: "scout",
        packageId: "custom-models",
        values: { model },
      },
      {
        type: "bot/set-package-settings",
        botId: "scout",
        packageId: "custom-models",
        unset: ["model"],
      },
    ]);
    expect(mounted.userLoads()).toBe(2);
    expect(mounted.botLoads()).toBe(2);
    mounted.dispose();
  });

  test("clears an account model whose Connection no longer resolves", async () => {
    const mounted = fixture({
      connectionId: "ollama-legacy",
      providerModelId: "glm-5.3-flash:cloud",
    });

    await mounted.state.setAccountModel(undefined);

    expect(mounted.commands).toMatchObject([
      {
        type: "user/set-package-settings",
        packageId: "custom-models",
        unset: ["account-model"],
      },
    ]);
    expect(mounted.userLoads()).toBe(1);
    mounted.dispose();
  });
});
