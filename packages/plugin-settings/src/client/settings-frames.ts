import {
  classifyClientFailureV1,
  type AgentTransport,
} from "@frockbot/client-core";
import {
  decodeProtocol,
  type SettingsChangeCommand,
  type SettingsFrame,
} from "@frockbot/protocol-schemas";
import type { InjectionKey } from "vue";
export type SettingsHome = "application" | "models";
export interface SettingsFrameClient {
  load(home: SettingsHome): Promise<SettingsFrame>;
  pending(home: SettingsHome): SettingsChangeCommand | undefined;
  save(
    home: SettingsHome,
    command: SettingsChangeCommand,
  ): Promise<"applied" | "rejected" | "pending">;
}
export const settingsFrameClientKey: InjectionKey<SettingsFrameClient> = Symbol(
  "frockbot.settings-frames",
);
export interface SettingsPendingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Both UI projections retain command identity; neither decides the outcome. */
export function createSettingsFrameClient(
  transport: AgentTransport,
  userId: () => string | undefined,
  store: SettingsPendingStore,
): SettingsFrameClient {
  const owner = () => {
    const id = userId();
    if (!id) throw new Error("Sign in to open Settings");
    return id;
  };
  const key = (home: SettingsHome) =>
    `frockbot.settings-pending.${owner()}.${home}`;
  return {
    async load(home) {
      const id = owner();
      if (!transport.readSettingsFrame)
        throw new Error("Update FrockBot to open Settings");
      const frame = decodeProtocol(
        "SettingsFrame",
        await transport.readSettingsFrame(home),
      );
      if (frame.ownerId !== id || frame.home !== home)
        throw new Error("Settings owner mismatch");
      return frame;
    },
    pending(home) {
      const saved = store.getItem(key(home));
      return saved
        ? decodeProtocol("SettingsChangeCommand", JSON.parse(saved))
        : undefined;
    },
    async save(home, input) {
      if (!transport.changeSettings)
        throw new Error("Update FrockBot to save Settings");
      const command = decodeProtocol("SettingsChangeCommand", input);
      const pending = this.pending(home);
      if (pending && JSON.stringify(pending) !== JSON.stringify(command))
        throw new Error("Check the pending save first");
      const commandKey = key(home);
      store.setItem(commandKey, JSON.stringify(command));
      try {
        const receipt = decodeProtocol(
          "SettingsReceipt",
          await transport.changeSettings(home, command),
        );
        if (receipt.commandId !== command.commandId)
          throw new Error("Settings receipt mismatch");
        if (receipt.status !== "pending") store.removeItem(commandKey);
        return receipt.status;
      } catch (error) {
        const status = classifyClientFailureV1(error).status;
        if (status !== undefined && status >= 400 && status < 500)
          store.removeItem(commandKey);
        throw error;
      }
    },
  };
}
