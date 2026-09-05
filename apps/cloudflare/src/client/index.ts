/// <reference path="./env.d.ts" />

import { foundationClientPlugins } from "@frockbot/application-foundation/client";
import { foundationMobilePackages } from "@frockbot/application-foundation/mobile";
import { startHostedMobileCapabilities } from "@frockbot/mobile/host";
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
  readJsonResponseV1,
  decodeRevocationResult,
  decodeStartConnectionResult,
  type ClientTurnResponse,
} from "@frockbot/client-core";
import {
  decodeClientRunListV1,
  decodeClientRunPageV1,
  decodeClientRunLookupV1,
  decodeClientRunStopReceiptV1,
  decodeClientTurnV1,
  decodeClientTurnRefusalV1,
  ClientTurnRefusedErrorV1,
} from "@frockbot/plugin-shell/run-protocol";
import { decodeClientSkillCatalogV1 } from "@frockbot/plugin-shell/skill-protocol";
import type { SkillRefV1 } from "@frockbot/kernel-contracts";
import { DEPLOYMENT_HEADER_V1 } from "@frockbot/protocol";
import { BrowserBotStateChannel } from "./bot-state-channel.js";
import { openVoiceDictationV1 } from "./voice-dictation.js";
import { openVoiceAssistantV1 } from "./voice-assistant.js";

/**
 * The application this page was served from, as the document itself records
 * it. The Worker-rendered document stamps it; the vite development document
 * does not, and there nothing can be behind.
 */
const servedDeployment = document.body.dataset.frockbotUserApplication;

const deploymentObservers = new Set<(deployment: string) => void>();

/**
 * Every answer names the application that produced it. Reading it here, on
 * the one path every request already takes, is what lets the shell notice a
 * release without a poll of its own.
 */
function observeDeploymentHeader(response: Response): void {
  const answered = response.headers.get(DEPLOYMENT_HEADER_V1);
  if (!answered) return;
  for (const observer of deploymentObservers) observer(answered);
}

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
    Object.keys(identity).length !== 3 ||
    !("userId" in identity) ||
    typeof identity.isAdmin !== "boolean"
  ) {
    throw new Error("Authenticated User identity is unavailable");
  }
  return requireAuthenticatedUserId(identity.userId);
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
    : await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body,
      });
  observeDeploymentHeader(response);
  /*
   * Every read of a response goes through the shared reader: it classifies a
   * failed or non-JSON reply rather than letting `JSON.parse` speak for it,
   * and the failure it throws carries the status. "What went wrong" and "is it
   * settled" are different questions and only the code answers the second: a
   * 4xx is the server having read the request and refused it, while a 5xx
   * leaves a send genuinely uncertain.
   */
  return await readJsonResponseV1(response);
}

const botStateChannel = new BrowserBotStateChannel();
const application = new ClientApplication({
  connectionsAvailable: true,
  ...(servedDeployment ? { servedDeployment } : {}),
  observeDeployment(observer) {
    deploymentObservers.add(observer);
    return () => {
      deploymentObservers.delete(observer);
    };
  },
  async turn(
    botId: string,
    text: string,
    signal: AbortSignal,
    commandId: string,
    skills?: readonly SkillRefV1[],
    supersedes?: { runId?: string },
  ): Promise<ClientTurnResponse> {
    signal.throwIfAborted();
    const path = `/api/bots/${encodeURIComponent(botId)}/turns`;
    const body = JSON.stringify({
      schemaVersion: 1,
      text,
      commandId,
      // Omitted rather than sent empty: the command decoder takes exact keys,
      // and "no Skills" is the absence of the field.
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(supersedes ? { supersedes } : {}),
    });
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
      : await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal,
        });
    signal.throwIfAborted();
    observeDeploymentHeader(response);
    /*
     * A refusal is the Bot answering, with a reason of its own, so it keeps
     * its typed error: flattening a 409 to a message sent the client down the
     * uncertain-admission path, which fenced the run and reported that the
     * message had not gone through over the top of what the Bot had said.
     * Every other failure is the shared reader's to classify.
     */
    if (!response.ok) {
      const refusal = decodeClientTurnRefusalV1(
        await response
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (refusal) throw new ClientTurnRefusedErrorV1(refusal);
    }
    return decodeClientTurnV1(await readJsonResponseV1(response));
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
  async readSkillCatalog(botId: string) {
    return decodeClientSkillCatalogV1(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/skills`),
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
  async startConversation(botId: string) {
    await apiRequest(
      `/api/bots/${encodeURIComponent(botId)}/conversations`,
      "POST",
      JSON.stringify({ schemaVersion: 1 }),
    );
  },
  async listAnnouncements(botId: string) {
    return decodeClientRunPageV1(
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/turns`),
    ).announcements;
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
  async stopRun(botId: string, runId: string, commandId: string) {
    const receipt = decodeClientRunStopReceiptV1(
      await apiRequest(
        `/api/bots/${encodeURIComponent(botId)}/turns/${encodeURIComponent(runId)}/stop`,
        "POST",
        JSON.stringify({
          schemaVersion: 1,
          action: "stop",
          commandId,
          runId,
        }),
      ),
    );
    return receipt.run;
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
  watchBotState(botId, observer) {
    return botStateChannel.watch(botId, observer);
  },
  openVoiceDictation(observer) {
    return openVoiceDictationV1(observer);
  },
  openVoiceAssistant(deviceId, observer) {
    return openVoiceAssistantV1(deviceId, observer);
  },
  async readAuthenticatedUserId() {
    return decodeAuthenticatedIdentity(await apiRequest("/api/identity"));
  },
  startConnection(input: {
    connectorId?: string;
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
        ...(input.connectorId ? { connectorId: input.connectorId } : {}),
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

await application.install(() => () => botStateChannel.dispose());
for (const plugin of foundationClientPlugins) await application.install(plugin);
application.mount("#app");
// Optional native Contributions never block the hosted product bootstrap.
void startHostedMobileCapabilities(foundationMobilePackages).catch(
  (error: unknown) =>
    console.error(
      "Optional mobile capabilities failed",
      error instanceof Error ? error.message : "unknown failure",
    ),
);
window.addEventListener("pagehide", () => application.dispose(), {
  once: true,
});
