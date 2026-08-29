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
import {
  decodeClientRunListV1,
  decodeClientTurnV1,
} from "@frockbot/plugin-shell/run-protocol";
import { createApp, ref, watch, type Ref } from "vue";
import { createMobileHost, type MobileHost } from "../host/index.ts";
import { createCapacitorAdapters } from "../host/capacitor-adapters.ts";
import {
  authSessionKey,
  defaultGatewayUrl,
  mobileBotIdKey,
  mobileHostKey,
} from "./app-context.ts";
import { createAuthSession } from "./auth.ts";
import { MobileBotProjectionController } from "./bot-projection.ts";
import { createDevicePreferenceStore } from "./capacitor-preferences.ts";
import { SHOW_NOTIFICATION_COMMAND } from "./commands.ts";
import { mobileContributions } from "./contributions.ts";
import { createContributionSlot } from "./ContributionSlot.ts";
import "./mobile.css";
import MobileAuthGate from "./MobileAuthGate.vue";
import {
  fenceRunAdmission,
  lookupRun,
  requestTurn,
  toolsFrom,
} from "./transport.ts";
import {
  admitMobileTurn,
  projectMobileTurnAdmissionLookup,
  reconcileMobileTurnAdmission,
} from "./turn-admission.ts";

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
let botProjection: MobileBotProjectionController;
let composerGeneration = 0;

function replaceMessage(runId: string, replacement: WebChatMessage): void {
  const index = web.value.messages.findIndex(
    (message) => message.runId === runId && message.role === "assistant",
  );
  if (index >= 0) web.value.messages[index] = replacement;
}

function responseError(value: unknown, fallback: string): string {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

function waitForAdmissionLookup(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", visibilityChanged);
      resolve();
    };
    const visibilityChanged = () => {
      if (!document.hidden) finish();
    };
    const timeout = setTimeout(finish, delayMs);
    if (document.hidden) {
      document.addEventListener("visibilitychange", visibilityChanged);
    }
  });
}

const web: Ref<FrockBotWebData> = ref({
  connection: "ready",
  modelLabel: "FrockBot gateway",
  settingsAvailable: true,
  connectionsAvailable: false,
  composerContext: "default:0",
  messages: [],
  pluginCatalog: [],
  async loadBotSettings(): Promise<void> {
    await botProjection.reload(botId.value);
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
  ): Promise<string | undefined> {
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
    const result = decodeStartConnectionResult(value);
    return result.status === "ready" ? undefined : result.redirectUrl;
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
    const projectionToken = botProjection.currentToken();
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
    const request = new AbortController();
    activeRequest = request;
    try {
      const admission = await admitMobileTurn({
        commandId: pendingRunId,
        prepare: async () => {
          if (!web.value.botSettings) await web.value.loadBotSettings();
        },
        isCurrent: () => botProjection.isCurrent(projectionToken),
        request: () =>
          requestTurn(
            auth.authorizedFetch,
            projectionToken.botId,
            text,
            pendingRunId,
            request.signal,
          ),
      });
      if (admission.status === "not-started") {
        if (botProjection.isCurrent(projectionToken)) {
          replaceMessage(pendingRunId, {
            id: crypto.randomUUID(),
            runId: pendingRunId,
            role: "assistant",
            text: "Turn was not admitted.",
            status: "error",
            tools: [],
          });
          web.value.error = admission.error
            ? admission.error instanceof Error
              ? admission.error.message
              : "Turn was not admitted"
            : undefined;
        }
        return {
          accepted: false,
          runId: pendingRunId,
          error: "Turn was not admitted",
        };
      }
      if (admission.status === "uncertain") {
        if (botProjection.isCurrent(projectionToken)) {
          replaceMessage(pendingRunId, {
            id: crypto.randomUUID(),
            runId: pendingRunId,
            role: "assistant",
            text: "Confirming whether this Turn was admitted.",
            status: "interrupted",
            tools: [],
          });
        }
        const lookup = await reconcileMobileTurnAdmission({
          lookup: () =>
            lookupRun(
              auth.authorizedFetch,
              projectionToken.botId,
              pendingRunId,
            ),
          fence: () =>
            fenceRunAdmission(
              auth.authorizedFetch,
              projectionToken.botId,
              pendingRunId,
            ),
          observe: (observed) => {
            const current = botProjection.currentToken();
            if (current.botId !== projectionToken.botId) return;
            web.value.settingsError = undefined;
            projectMobileTurnAdmissionLookup(web.value, pendingRunId, observed);
          },
          transientFailure: (error) => {
            const current = botProjection.currentToken();
            if (current.botId === projectionToken.botId) {
              web.value.settingsError = `${
                error instanceof Error
                  ? error.message
                  : "Turn admission lookup failed"
              } Retrying…`;
            }
          },
          wait: waitForAdmissionLookup,
        });
        if (lookup.state === "not-admitted") {
          return {
            accepted: false,
            runId: pendingRunId,
            error: "Turn was not admitted",
          };
        }
        return {
          accepted: true,
          runId: pendingRunId,
        };
      }

      const result = admission.response;
      if (!botProjection.isCurrent(projectionToken)) {
        return { accepted: true, runId: result.runId };
      }
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
        await botProjection.refreshHistory(projectionToken);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not refresh the admitted Turn";
      }
      return { accepted: true, runId: result.runId };
    } finally {
      if (activeRequest === request) activeRequest = undefined;
      if (
        botProjection.isCurrent(projectionToken) &&
        web.value.activeRunId === pendingRunId &&
        web.value.activeRun?.runId !== pendingRunId
      ) {
        web.value.activeRunId = undefined;
      }
    }
  },
  async resumeRun(runId: string): Promise<void> {
    const projectionToken = botProjection.currentToken();
    if (web.value.activeRun?.runId !== runId) return;
    web.value.activeRun = {
      runId,
      status: "running",
      message: "Reconciliation requested; waiting for durable progress.",
      canResume: false,
    };
    try {
      const response = await auth.authorizedFetch(
        `/api/bots/${encodeURIComponent(projectionToken.botId)}/turns/${encodeURIComponent(runId)}/reconcile`,
        {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 1, action: "resume" }),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(responseError(value, "Reconciliation failed"));
      }
      decodeClientTurnV1(value);
    } catch (error) {
      if (botProjection.isCurrent(projectionToken)) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Reconciliation failed";
      }
    }
    await botProjection.refreshHistory(projectionToken);
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

botProjection = new MobileBotProjectionController(botId.value, {
  state: () => web.value,
  async loadSettings(selectedBotId) {
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(selectedBotId)}/settings`,
    );
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(responseError(value, "Settings failed"));
    return decodeBotSettingsViewV1(value);
  },
  async listRuns(selectedBotId) {
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(selectedBotId)}/turns`,
    );
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(responseError(value, "Could not load completed Turns"));
    }
    return decodeClientRunListV1(value);
  },
  async listNotifications(selectedBotId) {
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(selectedBotId)}/notifications`,
    );
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(responseError(value, "Could not load notifications"));
    }
    return decodeNotificationList(value);
  },
  async deliverNotification(notification) {
    if (!document.hidden || !host) return;
    await host.invoke(SHOW_NOTIFICATION_COMMAND, {
      title: notification.title,
      body: notification.body,
    });
  },
  async acknowledgeNotification(selectedBotId, notificationId) {
    const response = await auth.authorizedFetch(
      `/api/bots/${encodeURIComponent(selectedBotId)}/notifications`,
      {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId,
        }),
      },
    );
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(
        responseError(value, "Could not acknowledge notification"),
      );
    }
    decodeAcknowledgement(value);
  },
});

watch(
  botId,
  (selectedBotId) => {
    activeRequest?.abort();
    activeRequest = undefined;
    composerGeneration += 1;
    web.value.composerContext = `${selectedBotId}:${composerGeneration}`;
    void botProjection.switchBot(selectedBotId);
  },
  { flush: "sync" },
);

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
