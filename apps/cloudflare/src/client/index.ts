/// <reference path="./env.d.ts" />

import { foundationClientPlugins } from "@frockbot/application-foundation/client";
import type {
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
} from "@frockbot/configuration-core";
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

async function configurationRequest<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<T> {
  const response = window.frockbotDesktop
    ? await window.frockbotDesktop.request({ path, method, body }).then(
        (result: DesktopApiResponse) =>
          new Response(result.body, {
            status: result.status,
            headers: result.contentType
              ? { "content-type": result.contentType }
              : undefined,
          }),
      )
    : await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body,
      });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "Settings request failed");
  return value;
}

const application = new ClientApplication({
  async turn(
    text: string,
    signal: AbortSignal,
    commandId: string,
  ): Promise<ClientTurnResponse> {
    signal.throwIfAborted();
    const path = `/api/bots/${encodeURIComponent(botId)}/turns`;
    const body = JSON.stringify({ text, commandId });
    const response = window.frockbotDesktop
      ? await window.frockbotDesktop
          .request({ path, method: "POST", body })
          .then(
            (result: DesktopApiResponse) =>
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
  readConfiguration(query: ConfigurationQueryV1) {
    const path =
      query.type === "user/get"
        ? "/api/settings"
        : `/api/bots/${encodeURIComponent(query.botId)}/settings`;
    return configurationRequest<ConfigurationViewV1>(path);
  },
  async listNotifications() {
    const result = await configurationRequest<{
      notifications: Array<{
        notificationId: string;
        createdAt: string;
        title: string;
        body: string;
      }>;
    }>(`/api/bots/${encodeURIComponent(botId)}/notifications`);
    return result.notifications;
  },
  async acknowledgeNotification(notificationId: string) {
    await configurationRequest<{ status: "acknowledged" }>(
      `/api/bots/${encodeURIComponent(botId)}/notifications`,
      "POST",
      JSON.stringify({ notificationId }),
    );
  },
  readApplicationManifest() {
    return configurationRequest<unknown>("/app-manifest");
  },
  startConnection(input: {
    commandId: string;
    packageId: string;
    connectionTypeId: string;
    botId: string;
    alias?: string;
  }) {
    if (input.packageId !== "composio") {
      return Promise.reject(new Error("Connection Package is unavailable"));
    }
    return configurationRequest<{
      connectionId: string;
      redirectUrl: string;
      expiresAt: string;
    }>(
      "/api/plugins/composio/connections",
      "POST",
      JSON.stringify({
        commandId: input.commandId,
        connectionTypeId: input.connectionTypeId,
        botId: input.botId,
        alias: input.alias,
      }),
    );
  },
  async revokeConnection(packageId: string, connectionId: string) {
    if (packageId !== "composio") {
      throw new Error("Connection Package is unavailable");
    }
    await configurationRequest<{ status: "revoked" }>(
      `/api/plugins/composio/connections/${encodeURIComponent(connectionId)}/revoke`,
      "POST",
    );
  },
  executeConfiguration(command: ConfigurationCommandV1) {
    const path =
      "botId" in command
        ? `/api/bots/${encodeURIComponent(command.botId)}/settings`
        : "/api/settings";
    return configurationRequest<OperationReceiptV1>(
      path,
      "POST",
      JSON.stringify(command),
    );
  },
});

for (const plugin of foundationClientPlugins) await application.install(plugin);
application.mount("#app");
window.addEventListener("pagehide", () => application.dispose(), {
  once: true,
});
