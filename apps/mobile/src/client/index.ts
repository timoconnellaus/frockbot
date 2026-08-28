import "@frockbot/client-core/fonts.css";
import type {
  BotNotificationPolicy,
  BotProfile,
  BotSettingsViewV1,
  OperationReceiptV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import "@frockbot/plugin-clock/client/styles.css";
import {
  clockWebDataKey,
  type ClockWebData,
} from "@frockbot/plugin-clock/shared";
import "@frockbot/plugin-shell/client/styles.css";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type PluginCatalogItem,
  type SendPromptResult,
  type WebChatMessage,
} from "@frockbot/plugin-shell/shared";
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

function mobilePluginCatalog(value: unknown): PluginCatalogItem[] {
  if (typeof value !== "object" || value === null || !("packages" in value)) {
    throw new Error("Application manifest is invalid");
  }
  const packages = (value as { packages?: unknown }).packages;
  if (!Array.isArray(packages))
    throw new Error("Application manifest is invalid");
  return packages.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const pkg = candidate as Record<string, unknown>;
    const configuration = pkg.configuration;
    if (typeof configuration !== "object" || configuration === null) return [];
    const connections = (configuration as Record<string, unknown>)
      .connectionTypes;
    if (!Array.isArray(connections) || connections.length === 0) return [];
    if (typeof pkg.id !== "string" || typeof pkg.version !== "string") {
      throw new Error("Application Package metadata is invalid");
    }
    return [
      {
        packageId: pkg.id,
        displayName:
          typeof pkg.displayName === "string" ? pkg.displayName : pkg.id,
        version: pkg.version,
        connectionTypes: connections as PluginCatalogItem["connectionTypes"],
      },
    ];
  });
}

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
  const result = (await response.json()) as {
    notifications?: Array<{
      notificationId: string;
      title: string;
      body: string;
    }>;
    error?: string;
  };
  if (!response.ok || !result.notifications) {
    throw new Error(result.error ?? "Could not load notifications");
  }
  for (const notification of result.notifications) {
    if (document.hidden) {
      if (!host) continue;
      await host.invoke(SHOW_NOTIFICATION_COMMAND, {
        title: notification.title,
        body: notification.body,
      });
    }
    await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(botId.value)}/notifications`,
      {
        method: "POST",
        body: JSON.stringify({ notificationId: notification.notificationId }),
      },
    );
  }
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
      const result = (await response.json()) as BotSettingsViewV1 & {
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Settings failed");
      web.value.botSettings = result;
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
    const result = (await response.json()) as OperationReceiptV1 & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Settings failed");
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
    const result = (await response.json()) as OperationReceiptV1 & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Settings failed");
    await web.value.loadBotSettings();
  },
  async loadUserSettings(): Promise<void> {
    const response = await auth.authorizedFetch("/api/settings");
    const result = (await response.json()) as UserSettingsViewV1 & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error ?? "Could not load settings");
    web.value.userSettings = result;
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
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error ?? "Could not save settings");
    }
    await web.value.loadUserSettings();
  },
  async loadPluginCatalog(): Promise<void> {
    const [manifestResponse, settingsResponse] = await Promise.all([
      auth.authorizedFetch("/app-manifest"),
      auth.authorizedFetch("/api/settings"),
    ]);
    const manifest = await manifestResponse.json();
    const settings = (await settingsResponse.json()) as UserSettingsViewV1 & {
      error?: string;
    };
    if (!manifestResponse.ok || !settingsResponse.ok) {
      throw new Error(settings.error ?? "Could not load Plugins");
    }
    web.value.pluginCatalog = mobilePluginCatalog(manifest);
    web.value.userSettings = settings;
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
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error ?? "Could not install Package");
    }
    await web.value.loadPluginCatalog();
  },
  async startConnection(
    packageId: string,
    connectionTypeId: string,
  ): Promise<string> {
    if (packageId !== "composio") {
      throw new Error("Connection Package is unavailable");
    }
    const response = await auth.authorizedFetch(
      "/api/plugins/composio/connections",
      {
        method: "POST",
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          connectionTypeId,
          botId: botId.value,
        }),
      },
    );
    const result = (await response.json()) as {
      redirectUrl?: string;
      error?: string;
    };
    if (!response.ok || !result.redirectUrl) {
      throw new Error(result.error ?? "Could not start Connection");
    }
    return result.redirectUrl;
  },
  async revokeConnection(
    packageId: string,
    connectionId: string,
  ): Promise<void> {
    if (packageId !== "composio") {
      throw new Error("Connection Package is unavailable");
    }
    const response = await auth.authorizedFetch(
      `/api/plugins/composio/connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST" },
    );
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error ?? "Could not revoke Connection");
    }
    await web.value.loadPluginCatalog();
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
