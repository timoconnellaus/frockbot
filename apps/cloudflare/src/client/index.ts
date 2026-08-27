import { foundationClientPlugins } from "@frockbot/application-foundation/client";
import {
  ClientApplication,
  type ClientTurnResponse,
} from "@frockbot/client-core";
function selectedBotId(): string {
  try {
    return new URL(window.location.href).searchParams.get("bot") ?? "default";
  } catch {
    return "default";
  }
}

const botId = selectedBotId();
const application = new ClientApplication({
  async turn(text: string, signal: AbortSignal): Promise<ClientTurnResponse> {
    signal.throwIfAborted();
    const path = `/api/bots/${encodeURIComponent(botId)}/turns`;
    const body = JSON.stringify({ text });
    const response = window.frockbotDesktop
      ? await window.frockbotDesktop.request({ path, method: "POST", body }).then(
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
          body,
          signal,
        });
    signal.throwIfAborted();
    const result = (await response.json()) as ClientTurnResponse & {
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Agent request failed");
    return result;
  },
});

for (const plugin of foundationClientPlugins) await application.install(plugin);
application.mount("#app");
window.addEventListener("pagehide", () => application.dispose(), { once: true });
