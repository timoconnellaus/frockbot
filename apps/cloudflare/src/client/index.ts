/// <reference path="./env.d.ts" />

import { foundationClientPlugins } from "@frockbot/application-foundation/client";
import {
  decodeBotSettingsViewV1,
  decodeOperationReceiptV1,
  decodeUserSettingsViewV1,
  isRpcIdentifier,
  type ConfigurationCommandV1,
  type ConfigurationQueryV1,
  type RevokeConnectionCommandV1,
  type StartConnectionCommandV1,
} from "@frockbot/configuration-core";
import {
  decodeConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/connection-core";
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
  decodeClientRunLookupV1,
  decodeClientTurnV1,
} from "@frockbot/plugin-shell/run-protocol";

const MOBILE_SHELL_ORIGINS = new Set([
  "capacitor://localhost",
  "frockbot://localhost",
]);

function requireAuthenticatedUserId(value: unknown): string {
  if (!isRpcIdentifier(value) || value === "anonymous") {
    throw new Error("Authenticated User identity is unavailable");
  }
  return value;
}

function decodeAuthenticatedIdentity(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authenticated User identity is unavailable");
  }
  const identity = value as Record<string, unknown>;
  if (
    identity.schemaVersion !== 1 ||
    Object.keys(identity).length !== 2 ||
    !("userId" in identity)
  ) {
    throw new Error("Authenticated User identity is unavailable");
  }
  return requireAuthenticatedUserId(identity.userId);
}

function usesMobileShell(): boolean {
  if (window.parent === window) return false;
  try {
    return (
      new URL(window.location.href).searchParams.get("mobile_shell") === "1"
    );
  } catch {
    return false;
  }
}

function mobileShellRequest(
  path: string,
  method: "GET" | "POST",
  body?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const id = crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    const finish = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        !MOBILE_SHELL_ORIGINS.has(event.origin) ||
        typeof event.data !== "object" ||
        event.data === null ||
        Array.isArray(event.data)
      )
        return;
      const value = event.data as Record<string, unknown>;
      const allowed = new Set([
        "schemaVersion",
        "type",
        "id",
        "status",
        "contentType",
        "body",
      ]);
      if (
        Object.keys(value).some((key) => !allowed.has(key)) ||
        value.schemaVersion !== 1 ||
        value.type !== "frockbot/mobile-api-response" ||
        value.id !== id ||
        typeof value.status !== "number" ||
        !Number.isInteger(value.status) ||
        value.status < 100 ||
        value.status > 599 ||
        typeof value.body !== "string" ||
        (value.contentType !== undefined &&
          typeof value.contentType !== "string")
      )
        return;
      window.removeEventListener("message", finish);
      signal?.removeEventListener("abort", aborted);
      resolve(
        new Response(value.body, {
          status: value.status,
          headers:
            typeof value.contentType === "string"
              ? { "content-type": value.contentType }
              : undefined,
        }),
      );
    };
    const aborted = () => {
      window.removeEventListener("message", finish);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    window.addEventListener("message", finish);
    window.parent.postMessage(
      {
        schemaVersion: 1,
        type: "frockbot/mobile-api-request",
        id,
        path,
        method,
        ...(body === undefined ? {} : { body }),
      },
      "*",
    );
  });
}

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
    : usesMobileShell()
      ? await mobileShellRequest(path, method, body)
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
  connectionsAvailable: true,
  async turn(
    botId: string,
    text: string,
    signal: AbortSignal,
    commandId: string,
  ): Promise<ClientTurnResponse> {
    signal.throwIfAborted();
    const path = `/api/bots/${encodeURIComponent(botId)}/turns`;
    const body = JSON.stringify({ schemaVersion: 1, text, commandId });
    const response = window.frockbotDesktop
      ? await Promise.race([
          window.frockbotDesktop
            .request({ schemaVersion: 1, path, method: "POST", body })
            .then(
              (result: DesktopApiResponse) =>
                new Response(result.body, {
                  status: result.status,
                  headers: result.contentType
                    ? { "content-type": result.contentType }
                    : undefined,
                }),
            ),
          new Promise<never>((_, reject) => {
            const aborted = () =>
              reject(new DOMException("Aborted", "AbortError"));
            if (signal.aborted) aborted();
            else signal.addEventListener("abort", aborted, { once: true });
          }),
        ])
      : usesMobileShell()
        ? await mobileShellRequest(path, "POST", body, signal)
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
  async listNotifications(botId: string) {
    return decodeNotificationList(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/notifications`),
    );
  },
  async listRuns(botId: string) {
    return decodeClientRunListV1(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/turns`),
    );
  },
  async lookupRun(botId: string, runId: string) {
    const lookup = decodeClientRunLookupV1(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}`,
      ),
    );
    return lookup.state === "not-admitted" ? undefined : lookup.run;
  },
  async fenceRunAdmission(botId: string, runId: string) {
    const lookup = decodeClientRunLookupV1(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}/fence`,
        "POST",
        JSON.stringify({ schemaVersion: 1, action: "fence-admission" }),
      ),
    );
    return lookup.state === "not-admitted" ? undefined : lookup.run;
  },
  async reconcileRun(botId: string, runId: string) {
    return decodeClientTurnV1(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}/reconcile`,
        "POST",
        JSON.stringify({ schemaVersion: 1, action: "resume" }),
      ),
    );
  },
  async acknowledgeNotification(botId: string, notificationId: string) {
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
  executeConnection(command: ConnectionCommandV1) {
    return apiRequest("/api/connections", "POST", JSON.stringify(command)).then(
      decodeConnectionCommandReceiptV1,
    );
  },
  async lookupConnectionCommand(packageId: string, commandId: string) {
    const value = await apiRequest(
      `/api/connection-commands?packageId=${encodeURIComponent(packageId)}&commandId=${encodeURIComponent(commandId)}`,
    );
    return value === null ? undefined : decodeConnectionCommandReceiptV1(value);
  },
  readApplicationManifest() {
    return apiRequest("/app-manifest");
  },
  hostedRequest(path, method = "GET", body) {
    return apiRequest(path, method, body);
  },
  async readAuthenticatedUserId() {
    return decodeAuthenticatedIdentity(await apiRequest("/api/identity"));
  },
  startConnection(input: {
    commandId: string;
    packageId: string;
    connectionTypeId: string;
    alias?: string;
    nativeReturnNonce?: string;
  }) {
    return apiRequest(
      `/api/plugins/${encodeURIComponent(input.packageId)}/connections`,
      "POST",
      JSON.stringify({
        schemaVersion: 1,
        type: "connection/start",
        commandId: input.commandId,
        connectionTypeId: input.connectionTypeId,
        alias: input.alias,
        nativeReturnNonce: input.nativeReturnNonce,
      } satisfies StartConnectionCommandV1),
    ).then(decodeStartConnectionResult);
  },
  async revokeConnection(packageId: string, connectionId: string) {
    decodeRevocationResult(
      await apiRequest(
        `/api/plugins/${encodeURIComponent(packageId)}/connections/${encodeURIComponent(connectionId)}/revoke`,
        "POST",
        JSON.stringify({
          schemaVersion: 1,
          type: "connection/revoke",
        } satisfies RevokeConnectionCommandV1),
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
