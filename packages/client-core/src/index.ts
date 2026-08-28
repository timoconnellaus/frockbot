import { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

export { decodeExternalAuthorizationUrl };

import type {
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
} from "@frockbot/configuration-core";
import {
  createApp,
  defineComponent,
  Fragment,
  h,
  type App,
  type Component,
  type InjectionKey,
} from "vue";

export interface ClientTurnEvent {
  type: string;
  call?: { id: string; name: string };
  callId?: string;
  content?: string;
  isError?: boolean;
  omittedInteractions?: number;
}

export interface ClientNotificationIntent {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
}

export interface ClientTurnResponse {
  runId: string;
  text: string;
  events: ClientTurnEvent[];
  notification?: ClientNotificationIntent;
}

export type ClientStartConnectionResult =
  | {
      status?: "authorization-required";
      connectionId: string;
      redirectUrl: string;
      expiresAt: string;
      nativeReturnNonce?: string;
    }
  | {
      status: "ready";
      connectionId: string;
      nativeReturnNonce?: string;
    };

export interface ClientRun {
  runId: string;
  admittedAt?: string;
  input: string;
  events: ClientTurnEvent[];
  status:
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | "reconciliation-required";
  responseText?: string;
  failure?: string;
  recovery?: { action: "resume"; message: string };
}

export interface AgentTransport {
  turn(
    text: string,
    signal: AbortSignal,
    commandId: string,
  ): Promise<ClientTurnResponse>;
  readConfiguration?(query: ConfigurationQueryV1): Promise<ConfigurationViewV1>;
  executeConfiguration?(
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
  readApplicationManifest?(): Promise<unknown>;
  startConnection?(input: {
    commandId: string;
    packageId: string;
    connectionTypeId: string;
    alias?: string;
  }): Promise<ClientStartConnectionResult>;
  listRuns?(): Promise<ClientRun[]>;
  reconcileRun?(runId: string): Promise<ClientTurnResponse>;
  revokeConnection?(packageId: string, connectionId: string): Promise<void>;
  listNotifications?(): Promise<ClientNotificationIntent[]>;
  acknowledgeNotification?(notificationId: string): Promise<void>;
  openExternalAuthorization?(
    url: string,
    nativeReturnNonce?: string,
  ): Promise<void>;
}

function responseRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function responseString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error(`${label}.${key} must be a string`);
  }
  return field;
}

function decodeTurnEvent(value: unknown): ClientTurnEvent {
  const event = responseRecord(value, "turn event");
  const decoded: ClientTurnEvent = {
    type: responseString(event, "type", "turn event"),
  };
  if (
    event.type === "tool/call" &&
    event.occurrenceId !== undefined &&
    event.name !== undefined
  ) {
    decoded.call = {
      id: responseString(event, "occurrenceId", "turn event"),
      name: responseString(event, "name", "turn event"),
    };
  } else if (event.call !== undefined) {
    const call = responseRecord(event.call, "tool call");
    decoded.call = {
      id: responseString(call, "id", "tool call"),
      name: responseString(call, "name", "tool call"),
    };
  }
  if (event.type === "tool/result" && event.occurrenceId !== undefined) {
    decoded.callId = responseString(event, "occurrenceId", "turn event");
  } else if (event.callId !== undefined) {
    decoded.callId = responseString(event, "callId", "turn event");
  }
  if (event.content !== undefined) {
    decoded.content = responseString(event, "content", "turn event");
  }
  if (event.isError !== undefined) {
    if (typeof event.isError !== "boolean") {
      throw new Error("turn event.isError must be a boolean");
    }
    decoded.isError = event.isError;
  }
  return decoded;
}

function decodeNotification(value: unknown): ClientNotificationIntent {
  const notification = responseRecord(value, "notification");
  const notificationId = responseString(
    notification,
    "notificationId",
    "notification",
  );
  const runId =
    notification.runId === undefined &&
    notificationId.startsWith("notification-")
      ? notificationId.slice("notification-".length)
      : responseString(notification, "runId", "notification");
  if (!runId) throw new Error("notification.runId must be a string");
  return {
    notificationId,
    runId,
    createdAt: responseString(notification, "createdAt", "notification"),
    title: responseString(notification, "title", "notification"),
    body: responseString(notification, "body", "notification"),
  };
}

export function decodeClientTurnResponse(input: unknown): ClientTurnResponse {
  const value = responseRecord(input, "turn response");
  if (!Array.isArray(value.events)) {
    throw new Error("turn response.events must be an array");
  }
  return {
    runId: responseString(value, "runId", "turn response"),
    text: responseString(value, "text", "turn response"),
    events: value.events.map(decodeTurnEvent),
    notification:
      value.notification === undefined
        ? undefined
        : decodeNotification(value.notification),
  };
}

export function decodeNotificationList(
  input: unknown,
): ClientNotificationIntent[] {
  const value = responseRecord(input, "notification list");
  if (!Array.isArray(value.notifications)) {
    throw new Error("notification list.notifications must be an array");
  }
  return value.notifications.map(decodeNotification);
}

export function decodeStartConnectionResult(
  input: unknown,
): ClientStartConnectionResult {
  const value = responseRecord(input, "Connection result");
  const connectionId = responseString(
    value,
    "connectionId",
    "Connection result",
  );
  const nativeReturnNonce = value.nativeReturnNonce;
  if (
    nativeReturnNonce !== undefined &&
    (typeof nativeReturnNonce !== "string" || !nativeReturnNonce)
  ) {
    throw new Error("Connection result.nativeReturnNonce must be a string");
  }
  if (value.status === "ready") {
    if (value.redirectUrl !== undefined || value.expiresAt !== undefined) {
      throw new Error("Ready Connection result must not include a redirect");
    }
    return {
      status: "ready",
      connectionId,
      ...(nativeReturnNonce ? { nativeReturnNonce } : {}),
    };
  }
  if (value.status !== undefined && value.status !== "authorization-required") {
    throw new Error("Connection result.status is invalid");
  }
  return {
    status: "authorization-required",
    connectionId,
    redirectUrl: decodeExternalAuthorizationUrl(
      responseString(value, "redirectUrl", "Connection result"),
    ),
    expiresAt: responseString(value, "expiresAt", "Connection result"),
    nativeReturnNonce,
  };
}

export function decodeAcknowledgement(input: unknown): void {
  const value = responseRecord(input, "acknowledgement");
  if (value.status !== "acknowledged") {
    throw new Error("acknowledgement status is invalid");
  }
}

export function decodeRevocationResult(input: unknown): void {
  const value = responseRecord(input, "revocation result");
  if (
    value.status !== "revoked" &&
    value.status !== "reconciliation-required"
  ) {
    throw new Error("revocation result status is invalid");
  }
}

export interface ClientSlotRegistration {
  slot: string;
  order: number;
  component: Component;
}

export interface ClientPluginContext {
  transport: AgentTransport;
  slot(registration: ClientSlotRegistration): () => void;
  provide<T>(key: InjectionKey<T>, value: T): () => void;
}

export type ClientPluginResult = void | (() => void) | readonly (() => void)[];
export type ClientPlugin = (
  context: ClientPluginContext,
) => ClientPluginResult | Promise<ClientPluginResult>;

interface ProviderRegistration {
  key: InjectionKey<unknown>;
  value: unknown;
}

function disposeResult(result: ClientPluginResult): void {
  if (typeof result === "function") {
    result();
  } else if (result) {
    for (const dispose of result.toReversed()) dispose();
  }
}

export class ClientApplication {
  private readonly registrations: ClientSlotRegistration[] = [];
  private readonly providers: ProviderRegistration[] = [];
  private readonly pluginDisposers: (() => void)[] = [];
  private app: App | undefined;

  constructor(readonly transport: AgentTransport) {}

  async install(plugin: ClientPlugin): Promise<void> {
    const result = await plugin({
      transport: this.transport,
      slot: (registration) => this.registerSlot(registration),
      provide: (key, value) => this.registerProvider(key, value),
    });
    this.pluginDisposers.push(() => disposeResult(result));
  }

  slots(name: string): readonly ClientSlotRegistration[] {
    return this.registrations
      .filter((registration) => registration.slot === name)
      .toSorted((left, right) => left.order - right.order);
  }

  mount(target: string | Element): void {
    if (this.app) throw new Error("client application is already mounted");
    const roots = this.slots("root");
    if (roots.length !== 1) {
      throw new Error(
        `client application requires one root, received ${roots.length}`,
      );
    }
    const outlet = defineComponent({
      props: { name: { type: String, required: true } },
      setup: (props: { name: string }) => () =>
        h(
          Fragment,
          this.slots(props.name).map((registration) =>
            h(registration.component, {
              key: `${props.name}:${registration.order}`,
            }),
          ),
        ),
    });
    const app = createApp(roots[0].component);
    for (const provider of this.providers) {
      app.provide(provider.key, provider.value);
    }
    app.component("k-slot", outlet);
    app.mount(target);
    this.app = app;
  }

  dispose(): void {
    this.app?.unmount();
    this.app = undefined;
    for (const dispose of this.pluginDisposers.splice(0).toReversed())
      dispose();
    this.registrations.length = 0;
    this.providers.length = 0;
  }

  private registerSlot(registration: ClientSlotRegistration): () => void {
    if (!registration.slot.trim())
      throw new Error("client slot must be non-empty");
    if (!Number.isFinite(registration.order)) {
      throw new Error("client slot order must be finite");
    }
    if (registration.slot === "root" && this.slots("root").length > 0) {
      throw new Error("client root is already registered");
    }
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index >= 0) this.registrations.splice(index, 1);
    };
  }

  private registerProvider<T>(key: InjectionKey<T>, value: T): () => void {
    const registration: ProviderRegistration = { key, value };
    this.providers.push(registration);
    return () => {
      const index = this.providers.indexOf(registration);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }
}
