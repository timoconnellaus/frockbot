import ClockCard from "@frockbot/plugin-clock/client/ClockCard.vue";
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
  type WebToolActivity,
} from "@frockbot/webui-shell/shared";
import { createApp, defineComponent, h, ref, type Ref } from "vue";
import AuthGate from "./AuthGate.vue";
import "./auth.css";

interface TurnEvent {
  type: string;
  call?: { id: string; name: string };
  callId?: string;
  content?: string;
  isError?: boolean;
}

interface TurnResponse {
  runId: string;
  text: string;
  events: TurnEvent[];
}

function selectedBotId(): string {
  try {
    return new URL(window.location.href).searchParams.get("bot") ?? "default";
  } catch {
    return "default";
  }
}

const botId = selectedBotId();
let activeRequest: AbortController | undefined;

function toolsFrom(events: TurnEvent[]): WebToolActivity[] {
  const tools = new Map<string, WebToolActivity>();
  for (const event of events) {
    if (event.type === "tool/call" && event.call) {
      tools.set(event.call.id, {
        id: event.call.id,
        name: event.call.name,
        status: "running",
      });
    }
    if (event.type === "tool/result" && event.callId) {
      const tool = tools.get(event.callId);
      if (tool) {
        tool.status = event.isError ? "failed" : "completed";
        tool.text = event.content;
      }
    }
  }
  return [...tools.values()];
}

function replaceMessage(runId: string, replacement: WebChatMessage): void {
  const index = web.value.messages.findIndex(
    (message) => message.runId === runId && message.role === "assistant",
  );
  if (index >= 0) web.value.messages[index] = replacement;
}

async function requestTurn(text: string): Promise<TurnResponse> {
  activeRequest = new AbortController();
  const path = `/api/bots/${encodeURIComponent(botId)}/turns`;
  const requestBody = JSON.stringify({ text });
  const response = window.frockbotDesktop
    ? await window.frockbotDesktop
        .request({
          path,
          method: "POST",
          body: requestBody,
        })
        .then(
          (result) =>
            new Response(result.body, {
              status: result.status,
              headers: result.contentType
                ? { "content-type": result.contentType }
                : undefined,
            }),
        )
    : await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: activeRequest.signal,
      });
  const body = (await response.json()) as TurnResponse & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Agent request failed");
  return body;
}

const web: Ref<FrockBotWebData> = ref({
  connection: "ready",
  modelLabel: "Foundation · Dynamic Worker",
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
    try {
      const result = await requestTurn(text);
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
      let errorMessage: string | undefined;
      if (!aborted) {
        errorMessage =
          error instanceof Error ? error.message : "Agent request failed";
      }
      web.value.error = errorMessage;
      return { accepted: true, runId: pendingRunId };
    } finally {
      activeRequest = undefined;
      web.value.activeRunId = undefined;
    }
  },
  async abort() {
    activeRequest?.abort();
  },
  async restart() {
    web.value.connection = "ready";
    web.value.error = undefined;
  },
});

const clock = ref<ClockWebData>({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lastTime: "Not requested yet",
  async refresh() {
    const result = await requestTurn("/time");
    clock.value.lastTime = result.text;
    return result.text;
  },
});

const ContributionSlot = defineComponent({
  props: { name: { type: String, required: true } },
  setup(props) {
    return () =>
      props.name === "frockbot.right-panel" ? h(ClockCard) : undefined;
  },
});

const app = createApp(AuthGate);
app.provide(frockBotWebDataKey, web);
app.provide(clockWebDataKey, clock);
app.component("k-slot", ContributionSlot);
app.mount("#app");
