/// <reference path="./env.d.ts" />

import { foundationClientPlugins } from "@frockbot/application-foundation/client";
import {
  decodeBotSettingsViewV1,
  decodeOperationReceiptV1,
  decodeUserSettingsViewV1,
  type ConfigurationCommandV1,
  type ConfigurationQueryV1,
} from "@frockbot/configuration-core";
import {
  ClientApplication,
  decodeAcknowledgement,
  decodeNotificationList,
  decodeRevocationResult,
  decodeStartConnectionResult,
  type ClientTurnResponse,
} from "@frockbot/client-core";
import {
  decodeClientRunListV1,
  decodeClientTurnV1,
} from "@frockbot/plugin-shell/run-protocol";

function selectedBotId(): string {
  try {
    return new URL(window.location.href).searchParams.get("bot") ?? "default";
  } catch {
    return "default";
  }
}

const botId = selectedBotId();

async function apiRequest(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: string,
): Promise<unknown> {
  const response = window.frockbotDesktop
    ? await window.frockbotDesktop
        .request({ schemaVersion: 1, path, method, body })
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
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body,
      });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error =
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error
        : "Hosted request failed";
    const failure = new Error(error) as Error & { definitive?: boolean };
    if (
      typeof value === "object" &&
      value !== null &&
      "definitive" in value &&
      value.definitive === true
    ) {
      failure.definitive = true;
    }
    throw failure;
  }
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
    const body = JSON.stringify({ schemaVersion: 1, text, commandId });
    const response = window.frockbotDesktop
      ? await window.frockbotDesktop
          .request({ schemaVersion: 1, path, method: "POST", body })
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
    const result: unknown = await response.json();
    if (!response.ok) {
      const error =
        typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string"
          ? result.error
          : "Agent request failed";
      throw new Error(error);
    }
    return decodeClientTurnV1(result);
  },
  readConfiguration(query: ConfigurationQueryV1) {
    const path =
      query.type === "user/get"
        ? "/api/settings"
        : `/api/bots/${encodeURIComponent(query.botId)}/settings`;
    return apiRequest(path).then((value) =>
      query.type === "user/get"
        ? decodeUserSettingsViewV1(value)
        : decodeBotSettingsViewV1(value),
    );
  },
  async listNotifications() {
    return decodeNotificationList(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/notifications`),
    );
  },
  async listRuns() {
    return decodeClientRunListV1(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/turns`),
    );
  },
  async reconcileRun(runId: string) {
    return decodeClientTurnV1(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}/reconcile`,
        "POST",
        JSON.stringify({ schemaVersion: 1, action: "resume" }),
      ),
    );
  },
  async acknowledgeNotification(notificationId: string) {
    decodeAcknowledgement(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/notifications`,
        "POST",
        JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId,
        }),
      ),
    );
  },
  readApplicationManifest() {
    return apiRequest("/app-manifest");
  },
  startConnection(input: {
    commandId: string;
    packageId: string;
    connectionTypeId: string;
    alias?: string;
  }) {
    const nativeReturnNonce = window.frockbotDesktop
      ? crypto.randomUUID()
      : undefined;
    return apiRequest(
      `/api/plugins/${encodeURIComponent(input.packageId)}/connections`,
      "POST",
      JSON.stringify({
        commandId: input.commandId,
        connectionTypeId: input.connectionTypeId,
        alias: input.alias,
        nativeReturnNonce,
      }),
    ).then(decodeStartConnectionResult);
  },
  async revokeConnection(packageId: string, connectionId: string) {
    decodeRevocationResult(
      await apiRequest(
        `/api/plugins/${encodeURIComponent(packageId)}/connections/${encodeURIComponent(connectionId)}/revoke`,
        "POST",
      ),
    );
  },
  openExternalAuthorization(
    url: string,
    nativeReturnNonce?: string,
  ): Promise<void> {
    if (window.frockbotDesktop) {
      return window.frockbotDesktop.openExternalAuthorization(
        url,
        nativeReturnNonce,
      );
    }
    window.location.assign(url);
    return Promise.resolve();
  },
  executeConfiguration(command: ConfigurationCommandV1) {
    const path =
      "botId" in command
        ? `/api/bots/${encodeURIComponent(command.botId)}/settings`
        : "/api/settings";
    return apiRequest(path, "POST", JSON.stringify(command)).then(
      decodeOperationReceiptV1,
    );
  },
});

for (const plugin of foundationClientPlugins) await application.install(plugin);
application.mount("#app");
window.addEventListener("pagehide", () => application.dispose(), {
  once: true,
});
