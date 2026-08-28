import "@frockbot/client-core/fonts.css";
import type {
  BotNotificationPolicy,
  BotProfile,
} from "@frockbot/configuration-core";
import {
  decodeBotSettingsViewV1,
  decodeOperationReceiptV1,
  decodeUserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeAcknowledgement,
  decodeNotificationList,
  decodeRevocationResult,
  decodeRunList,
  decodeStartConnectionResult,
} from "@frockbot/client-core";
import "@frockbot/plugin-clock/client/styles.css";
import {
  clockWebDataKey,
  type ClockWebData,
} from "@frockbot/plugin-clock/shared";
import "@frockbot/plugin-shell/client/styles.css";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type SendPromptResult,
  type WebChatMessage,
} from "@frockbot/plugin-shell/shared";
import { decodePluginCatalog } from "@frockbot/plugin-shell/client";
import { createApp, ref, type Ref } from "vue";
import { createMobileHost, type MobileHost } from "../host/index.ts";
import { createCapacitorAdapters } from "../host/capacitor-adapters.ts";
import {
  authSessionKey,
  defaultGatewayUrl,
  mobileBotIdKey,
  mobileHostKey,
} from "./app-context.ts";
import { createAuthSession } from "./auth.ts";
import { createDevicePreferenceStore } from "./capacitor-preferences.ts";
import { SHOW_NOTIFICATION_COMMAND } from "./commands.ts";
import { mobileContributions } from "./contributions.ts";
import { createContributionSlot } from "./ContributionSlot.ts";
import "./mobile.css";
import MobileAuthGate from "./MobileAuthGate.vue";
import { requestTurn, toolsFrom } from "./transport.ts";

const browserFetch = globalThis.fetch.bind(globalThis);

const auth = createAuthSession({
  store: createDevicePreferenceStore(),
  fetch: (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("gateway requests require a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("gateway requests require an http(s) URL");
    }
    return browserFetch(url, init);
  },
  defaultGatewayUrl: defaultGatewayUrl || undefined,
});

const botId = ref("default");
let activeRequest: AbortController | undefined;
let host: MobileHost | undefined;

function replaceMessage(runId: string, replacement: WebChatMessage): void {
  const index = web.value.messages.findIndex(
    (message) => message.runId === runId && message.role === "assistant",
  );
  if (index >= 0) web.value.messages[index] = replacement;
}

async function deliverMobileNotifications(): Promise<void> {
  const response = await auth.authorizedFetch(
    `/api/bots/${encodeURIComponent(botId.value)}/notifications`,
  );
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(responseError(value, "Could not load notifications"));
  const notifications = decodeNotificationList(value);
  const runsResponse = await auth.authorizedFetch(
    `/api/bots/${encodeURIComponent(botId.value)}/turns`,
  );
  const runsValue: unknown = await runsResponse.json();
  if (!runsResponse.ok) {
    throw new Error(responseError(runsValue, "Could not load completed Turns"));
  }
  const runs = decodeRunList(runsValue);
  for (const notification of notifications) {
    const run = runs.find(
      (candidate) => candidate.runId === notification.runId,
    );
    if (!run || run.status !== "completed") continue;
    if (!web.value.messages.some((message) => message.runId === run.runId)) {
      web.value.messages.push(
        {
          id: `${run.runId}:user`,
          runId: run.runId,
          role: "user",
          text: run.input,
          status: "completed",
          tools: [],
        },
        {
          id: `${run.runId}:assistant`,
          runId: run.runId,
          role: "assistant",
          text: run.responseText ?? notification.body,
          status: "completed",
          tools: toolsFrom(run.events),
        },
      );
    }
    if (document.hidden) {
      if (!host) continue;
      await host.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: notification.title,
        body: notification.body,
      });
    }
    const acknowledgement = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(botId.value)}/notifications`,
      {
        method: "POST",
        body: JSON.stringify({ notificationId: notification.notificationId }),
      },
    );
    const acknowledgementValue: unknown = await acknowledgement.json();
    if (!acknowledgement.ok) {
      throw new Error(
        responseError(
          acknowledgementValue,
          "Could not acknowledge notification",
        ),
      );
    }
    decodeAcknowledgement(acknowledgementValue);
  }
}

function responseError(value: unknown, fallback: string): string {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

const web: Ref<FrockBotWebData> = ref({
  connection: "ready",
  modelLabel: "FrockBot gateway",
  settingsAvailable: true,
  connectionsAvailable: false,
  messages: [],
  pluginCatalog: [],
  async loadBotSettings(): Promise<void> {
    try {
      const response = await auth.authorizedFetch(
        `/api/bots/${encodeURIComponent(botId.value)}/settings`,
      );
      const value: unknown = await response.json();
      if (!response.ok)
        throw new Error(responseError(value, "Settings failed"));
      web.value.botSettings = decodeBotSettingsViewV1(value);
      web.value.settingsError = undefined;
      await deliverMobileNotifications();
    } catch (error) {
      web.value.settingsError =
        error instanceof Error ? error.message : "Could not load settings";
    }
  },
  async saveBotProfile(profile: BotProfile): Promise<void> {
    const current = web.value.botSettings;
    if (!current) throw new Error("Settings are unavailable");
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(botId.value)}/settings`,
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: crypto.randomUUID(),
          botId: botId.value,
          expectedRevision: current.revision,
          profile,
        }),
      },
    );
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(responseError(value, "Settings failed"));
    decodeOperationReceiptV1(value);
    await web.value.loadBotSettings();
  },
  async saveBotNotifications(
    notifications: BotNotificationPolicy,
  ): Promise<void> {
    const current = web.value.botSettings;
    if (!current) throw new Error("Settings are unavailable");
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(botId.value)}/settings`,
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "bot/update-notifications",
          commandId: crypto.randomUUID(),
          botId: botId.value,
          expectedRevision: current.revision,
          notifications,
        }),
      },
    );
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(responseError(value, "Settings failed"));
    decodeOperationReceiptV1(value);
    await web.value.loadBotSettings();
  },
  async loadUserSettings(): Promise<void> {
    const response = await auth.authorizedFetch("/api/settings");
    const value: unknown = await response.json();
    if (!response.ok)
      throw new Error(responseError(value, "Could not load settings"));
    web.value.userSettings = decodeUserSettingsViewV1(value);
  },
  async saveUserProfile(profile: {
    name: string;
    email?: string;
  }): Promise<void> {
    const settings = web.value.userSettings;
    if (!settings) throw new Error("Settings are unavailable");
    const response = await auth.authorizedFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        profile,
      }),
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw new Error(responseError(value, "Could not save settings"));
    decodeOperationReceiptV1(value);
    await web.value.loadUserSettings();
  },
  async loadPluginCatalog(): Promise<void> {
    const [manifestResponse, settingsResponse] = await Promise.all([
      auth.authorizedFetch("/app-manifest"),
      auth.authorizedFetch("/api/settings"),
    ]);
    const manifest: unknown = await manifestResponse.json();
    const settingsValue: unknown = await settingsResponse.json();
    if (!manifestResponse.ok || !settingsResponse.ok) {
      throw new Error(responseError(settingsValue, "Could not load Plugins"));
    }
    web.value.pluginCatalog = decodePluginCatalog(manifest);
    web.value.userSettings = decodeUserSettingsViewV1(settingsValue);
  },
  async installPackage(packageId: string, version: string): Promise<void> {
    const settings = web.value.userSettings;
    if (!settings) throw new Error("Plugins are unavailable");
    const response = await auth.authorizedFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        type: "user/install-package",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
        version,
      }),
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw new Error(responseError(value, "Could not install Package"));
    decodeOperationReceiptV1(value);
    await web.value.loadPluginCatalog();
  },
  async startConnection(
    packageId: string,
    connectionTypeId: string,
  ): Promise<string> {
    const response = await auth.authorizedFetch(
      `/api/plugins/${encodeURIComponent(packageId)}/connections`,
      {
        method: "POST",
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          connectionTypeId,
        }),
      },
    );
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(responseError(value, "Could not start Connection"));
    }
    return decodeStartConnectionResult(value).redirectUrl;
  },
  async revokeConnection(
    packageId: string,
    connectionId: string,
  ): Promise<void> {
    const response = await auth.authorizedFetch(
      `/api/plugins/${encodeURIComponent(packageId)}/connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST" },
    );
    const value: unknown = await response.json();
    if (!response.ok)
      throw new Error(responseError(value, "Could not revoke Connection"));
    decodeRevocationResult(value);
    await web.value.loadPluginCatalog();
  },
  openConnectionAuthorization(): Promise<void> {
    return Promise.reject(new Error("Connections are unavailable on mobile"));
  },
  async sendPrompt(text: string): Promise<SendPromptResult> {
    if (web.value.activeRunId) return { accepted: false, error: "busy" };
    const pendingRunId = crypto.randomUUID();
    web.value.activeRunId = pendingRunId;
    web.value.error = undefined;
    web.value.messages.push(
      {
        id: crypto.randomUUID(),
        runId: pendingRunId,
        role: "user",
        text,
        status: "completed",
        tools: [],
      },
      {
        id: crypto.randomUUID(),
        runId: pendingRunId,
        role: "assistant",
        text: "",
        status: "streaming",
        tools: [],
      },
    );
    activeRequest = new AbortController();
    try {
      if (!web.value.botSettings) await web.value.loadBotSettings();
      const result = await requestTurn(
        auth.authorizedFetch,
        botId.value,
        text,
        pendingRunId,
        activeRequest.signal,
      );
      for (const message of web.value.messages) {
        if (message.runId === pendingRunId) message.runId = result.runId;
      }
      replaceMessage(result.runId, {
        id: crypto.randomUUID(),
        runId: result.runId,
        role: "assistant",
        text: result.text,
        status: "completed",
        tools: toolsFrom(result.events),
      });
      try {
        await deliverMobileNotifications();
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Notification delivery failed";
      }
      return { accepted: true, runId: result.runId };
    } catch (error) {
      const aborted =
        error instanceof DOMException && error.name === "AbortError";
      replaceMessage(pendingRunId, {
        id: crypto.randomUUID(),
        runId: pendingRunId,
        role: "assistant",
        text: aborted ? "Request stopped locally." : "Agent request failed.",
        status: aborted ? "aborted" : "error",
        tools: [],
      });
      web.value.error = aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : "Agent request failed";
      return { accepted: true, runId: pendingRunId };
    } finally {
      activeRequest = undefined;
      web.value.activeRunId = undefined;
    }
  },
  abort(): Promise<void> {
    activeRequest?.abort();
    return Promise.resolve();
  },
  restart(): Promise<void> {
    web.value.connection = "ready";
    web.value.error = undefined;
    return Promise.resolve();
  },
});

const clock: Ref<ClockWebData> = ref({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastTime: "Not requested yet",
  refresh(): Promise<string> {
    const now = new Date().toLocaleTimeString();
    clock.value.lastTime = now;
    return Promise.resolve(now);
  },
});

async function start(): Promise<void> {
  try {
    host = await createMobileHost({ adapters: createCapacitorAdapters() });
  } catch (error) {
    web.value.error =
      error instanceof Error
        ? `Mobile host failed: ${error.message}`
        : "Mobile host failed to start";
  }

  const app = createApp(MobileAuthGate);
  app.provide(frockBotWebDataKey, web);
  app.provide(clockWebDataKey, clock);
  app.provide(authSessionKey, auth);
  app.provide(mobileBotIdKey, botId);
  if (host) app.provide(mobileHostKey, host);
  app.component("k-slot", createContributionSlot(mobileContributions));
  app.mount("#app");
}

void start();
