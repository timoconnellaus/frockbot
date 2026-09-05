import {
  classifyClientFailureV1,
  type AgentTransport,
} from "@frockbot/client-core";
import {
  decodeProtocol,
  isProtocolValue,
  type SettingsChangeCommand,
  type SettingsFrame,
  type SettingsOptionsQuery,
  type SettingsOptionsPage,
} from "@frockbot/protocol-schemas";
import type { InjectionKey } from "vue";
export type SettingsHome = "application" | "models";
export interface SettingsFrameClient {
  options(query: SettingsOptionsQuery): Promise<SettingsOptionsPage>;
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
  transport: Pick<
    AgentTransport,
    "readSettingsFrame" | "readSettingsOptions" | "changeSettings"
  >,
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
    async options(input) {
      const id = owner();
      if (!transport.readSettingsOptions)
        throw new Error("Update FrockBot to browse models");
      const query = decodeProtocol("SettingsOptionsQuery", input);
      const page = decodeProtocol(
        "SettingsOptionsPage",
        await transport.readSettingsOptions(query),
      );
      if (
        owner() !== id ||
        page.ownerId !== id ||
        page.source !== query.source ||
        page.revision !== query.revision
      )
        throw new Error("Model catalog changed");
      return page;
    },
    async load(home) {
      const id = owner();
      if (!transport.readSettingsFrame)
        throw new Error("Update FrockBot to open Settings");
      const frame = decodeProtocol(
        "SettingsFrame",
        await transport.readSettingsFrame(home),
      );
      if (owner() !== id || frame.ownerId !== id || frame.home !== home)
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
      // Vue can supply nested reactive proxies, which structuredClone refuses.
      // Validate first, then materialize the exact JSON sent over the wire.
      if (!isProtocolValue("SettingsChangeCommand", input))
        throw new Error("Invalid settings command");
      const command = decodeProtocol(
        "SettingsChangeCommand",
        JSON.parse(JSON.stringify(input)),
      );
      const pending = this.pending(home);
      if (pending && JSON.stringify(pending) !== JSON.stringify(command))
        throw new Error("Check the pending save first");
      const id = owner();
      if (command.ownerId !== id) throw new Error("Settings owner mismatch");
      const commandKey = key(home);
      store.setItem(commandKey, JSON.stringify(command));
      try {
        const receipt = decodeProtocol(
          "SettingsReceipt",
          await transport.changeSettings(home, command),
        );
        if (owner() !== id || receipt.commandId !== command.commandId)
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
