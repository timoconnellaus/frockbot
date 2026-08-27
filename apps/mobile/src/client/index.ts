import "@frockbot/plugin-clock/client/styles.css";
import {
  clockWebDataKey,
  type ClockWebData,
} from "@frockbot/plugin-clock/shared";
import "@frockbot/webui-shell/client/styles.css";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type SendPromptResult,
  type WebChatMessage,
} from "@frockbot/webui-shell/shared";
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

const auth = createAuthSession({
  store: createDevicePreferenceStore(),
  fetch: (input, init) => fetch(input, init),
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

async function notifyCompletion(text: string): Promise<void> {
  if (!host || !document.hidden) return;
  try {
    await host.invoke(SHOW_NOTIFICATION_COMMAND, {
      title: `${botId.value} replied`,
      body: text.slice(0, 240),
    });
  } catch {
    return;
  }
}

const web: Ref<FrockBotWebData> = ref({
  connection: "ready",
  modelLabel: "FrockBot gateway",
  messages: [],
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
      const result = await requestTurn(
        auth.authorizedFetch,
        botId.value,
        text,
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
      await notifyCompletion(result.text);
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
