import type {
  ClientNotificationIntent,
  ClientRun,
} from "@frockbot/client-core";
import type { BotSettingsViewV1 } from "@frockbot/configuration-core";
import { projectCompletedRuns } from "@frockbot/plugin-shell/client";
import type { WebChatMessage } from "@frockbot/plugin-shell/shared";

export interface MobileBotProjectionState {
  botSettings?: BotSettingsViewV1;
  messages: WebChatMessage[];
  activeRunId?: string;
  error?: string;
  settingsError?: string;
}

export interface MobileBotProjectionToken {
  botId: string;
  generation: number;
}

export interface MobileBotProjectionDependencies {
  state(): MobileBotProjectionState;
  loadSettings(botId: string): Promise<BotSettingsViewV1>;
  listRuns(botId: string): Promise<ClientRun[]>;
  listNotifications(botId: string): Promise<ClientNotificationIntent[]>;
  deliverNotification(notification: ClientNotificationIntent): Promise<void>;
  acknowledgeNotification(botId: string, notificationId: string): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class MobileBotProjectionController {
  #botId: string;
  #generation = 0;
  readonly #dependencies: MobileBotProjectionDependencies;

  constructor(
    initialBotId: string,
    dependencies: MobileBotProjectionDependencies,
  ) {
    this.#botId = initialBotId;
    this.#dependencies = dependencies;
  }

  currentToken(): MobileBotProjectionToken {
    return { botId: this.#botId, generation: this.#generation };
  }

  isCurrent(token: MobileBotProjectionToken): boolean {
    return (
      token.botId === this.#botId && token.generation === this.#generation
    );
  }

  switchBot(botId: string): Promise<void> {
    this.#botId = botId;
    this.#generation += 1;
    const state = this.#dependencies.state();
    state.botSettings = undefined;
    state.messages = [];
    state.activeRunId = undefined;
    state.error = undefined;
    state.settingsError = undefined;
    return this.#load(this.currentToken());
  }

  reload(botId: string): Promise<void> {
    if (botId !== this.#botId) return Promise.resolve();
    return this.#load(this.currentToken());
  }

  refreshHistory(token = this.currentToken()): Promise<void> {
    if (!this.isCurrent(token)) return Promise.resolve();
    return this.#loadHistory(token);
  }

  async #load(token: MobileBotProjectionToken): Promise<void> {
    if (this.isCurrent(token)) {
      this.#dependencies.state().settingsError = undefined;
    }
    await Promise.all([this.#loadSettings(token), this.#loadHistory(token)]);
  }

  async #loadSettings(token: MobileBotProjectionToken): Promise<void> {
    try {
      const settings = await this.#dependencies.loadSettings(token.botId);
      if (this.isCurrent(token)) {
        this.#dependencies.state().botSettings = settings;
      }
    } catch (error) {
      if (this.isCurrent(token)) {
        this.#dependencies.state().settingsError = errorMessage(
          error,
          "Could not load settings",
        );
      }
    }
  }

  async #loadHistory(token: MobileBotProjectionToken): Promise<void> {
    let runs: ClientRun[];
    try {
      runs = await this.#dependencies.listRuns(token.botId);
    } catch (error) {
      if (this.isCurrent(token)) {
        this.#dependencies.state().settingsError = errorMessage(
          error,
          "Could not load completed Turns",
        );
      }
      return;
    }
    if (!this.isCurrent(token)) return;
    projectCompletedRuns(this.#dependencies.state().messages, [], runs);
    await this.#deliverNotifications(token, runs);
  }

  async #deliverNotifications(
    token: MobileBotProjectionToken,
    runs: readonly ClientRun[],
  ): Promise<void> {
    let notifications: ClientNotificationIntent[];
    try {
      notifications = await this.#dependencies.listNotifications(token.botId);
    } catch (error) {
      if (this.isCurrent(token)) {
        this.#dependencies.state().settingsError ??= errorMessage(
          error,
          "Could not load notifications",
        );
      }
      return;
    }
    if (!this.isCurrent(token)) return;

    const projected = projectCompletedRuns(
      this.#dependencies.state().messages,
      notifications,
      runs,
    );
    for (const notification of notifications) {
      if (!projected.has(notification.notificationId)) continue;
      try {
        await this.#dependencies.deliverNotification(notification);
        if (!this.isCurrent(token)) return;
        await this.#dependencies.acknowledgeNotification(
          token.botId,
          notification.notificationId,
        );
      } catch (error) {
        if (!this.isCurrent(token)) return;
        this.#dependencies.state().settingsError = errorMessage(
          error,
          "Notification delivery failed",
        );
      }
    }
  }
}
