import type { SkillRefV1 } from "@frockbot/kernel-contracts";
import {
  decodeRevokeConnectionResultV1,
  decodeStartConnectionResultV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type StartConnectionResult,
  // pi-lens-ignore: ts:2307
} from "@frockbot/connection-core";
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
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";

export interface ClientTurnEvent {
  type: string;
  call?: { id: string; name: string };
  callId?: string;
  content?: string;
  isError?: boolean;
  omittedInteractions?: number;
  /**
   * A `send/to-user` payload, carried untyped because the client core holds no
   * product shapes. The Package that owns the send surface decodes it with the
   * versioned decoder in kernel-contracts before drawing it.
   */
  payload?: unknown;
  /** A `wake/parent` hand-off message. */
  message?: string;
  /**
   * A `task/dispatched` subagent chip. Flat and optional, like every other
   * field here: the client core holds no product shapes, and which roles exist
   * is the Subagents Package's opinion, not this one's.
   */
  taskId?: string;
  taskType?: string;
  description?: string;
  model?: string;
  background?: boolean;
  /**
   * Binaries a tool filed in a durable root. References — media type, content
   * hash, and the encoded Workspace path — never bytes: the client core holds
   * no product shapes and a thread carries paths, not images.
   */
  attachments?: {
    kind: "image";
    mediaType: string;
    contentHash: string;
    bytes: number;
    path: string;
  }[];
}

export interface ClientNotificationIntent {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
  /** `critical` for an intent the Bot's notification policy does not gate. */
  urgency?: "normal" | "critical";
  /** The Channel a group message raised this intent in, when one did. */
  channelId?: string;
}

export interface ClientNotificationListV1 {
  schemaVersion: 1;
  notifications: ClientNotificationIntent[];
}

export interface ClientNotificationAcknowledgementV1 {
  schemaVersion: 1;
  status: "acknowledged";
}

export interface ClientTurnResponse {
  runId: string;
  text: string;
  events: ClientTurnEvent[];
  notification?: ClientNotificationIntent;
}

export type ClientStartConnectionResult = StartConnectionResult;

/**
 * A durable Session event that belongs to no Turn — a rename, today. The chat
 * shows it as a system line rather than as a message from either party.
 */
export interface ClientAnnouncement {
  type: "bot/renamed";
  announcementId: string;
  at: string;
  from: string;
  to: string;
  namedBy: "user" | "bot";
}

export interface ClientRun {
  runId: string;
  admittedAt?: string;
  input: string;
  events: ClientTurnEvent[];
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "reconciliation-required";
  responseText?: string;
  failure?: string;
  /** Durable Stop intent, projected independently of the run status. */
  stopRequestedAt?: string;
  recovery?: { action: "resume"; message: string };
}

export interface AgentTransport {
  /** False when this platform cannot complete external Connection authorization. */
  readonly connectionsAvailable?: boolean;
  turn(
    botId: string,
    text: string,
    signal: AbortSignal,
    commandId: string,
    /**
     * The Skills this message invokes, as canonical refs. Optional so a
     * transport that has no composer — a Routine's, a test's — needs no change.
     */
    skills?: readonly SkillRefV1[],
  ): Promise<ClientTurnResponse>;
  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover.
   * Optional: a platform that cannot read it simply offers no popover.
   */
  readSkillCatalog?(botId: string): Promise<unknown>;
  readConfiguration?(query: ConfigurationQueryV1): Promise<ConfigurationViewV1>;
  executeConfiguration?(
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
  executeConnection?(
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1>;
  lookupConnectionCommand?(
    packageId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined>;
  readApplicationManifest?(): Promise<unknown>;
  readAuthenticatedUserId?(): Promise<string>;
  startConnection?(input: {
    commandId: string;
    packageId: string;
    connectionTypeId: string;
    alias?: string;
    nativeReturnNonce?: string;
  }): Promise<ClientStartConnectionResult>;
  listRuns?(botId: string): Promise<ClientRun[]>;
  listAnnouncements?(botId: string): Promise<ClientAnnouncement[]>;
  lookupRun?(botId: string, runId: string): Promise<ClientRun | undefined>;
  fenceRunAdmission?(
    botId: string,
    runId: string,
  ): Promise<ClientRun | undefined>;
  reconcileRun?(botId: string, runId: string): Promise<ClientTurnResponse>;
  /** Sends the durable Stop command and returns the acknowledged projection. */
  stopRun?(botId: string, runId: string, commandId: string): Promise<ClientRun>;
  revokeConnection?(packageId: string, connectionId: string): Promise<void>;
  listNotifications?(botId: string): Promise<ClientNotificationIntent[]>;
  acknowledgeNotification?(
    botId: string,
    notificationId: string,
  ): Promise<void>;
  hostedRequest?(
    path: string,
    method?: "GET" | "POST",
    body?: string,
  ): Promise<unknown>;
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

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
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
  if (event.payload !== undefined) decoded.payload = event.payload;
  if (event.message !== undefined) {
    decoded.message = responseString(event, "message", "turn event");
  }
  if (event.taskId !== undefined) {
    decoded.taskId = responseString(event, "taskId", "turn event");
    decoded.taskType = responseString(event, "taskType", "turn event");
    decoded.description = responseString(event, "description", "turn event");
    decoded.model = responseString(event, "model", "turn event");
    if (typeof event.background !== "boolean") {
      throw new Error("turn event.background must be a boolean");
    }
    decoded.background = event.background;
  }
  return decoded;
}

function decodeNotification(value: unknown): ClientNotificationIntent {
  const notification = responseRecord(value, "notification");
  if (
    !hasExactKeys(
      notification,
      ["notificationId", "runId", "createdAt", "title", "body"],
      ["urgency", "channelId"],
    )
  ) {
    throw new Error("notification is invalid");
  }
  return {
    notificationId: responseString(
      notification,
      "notificationId",
      "notification",
    ),
    runId: responseString(notification, "runId", "notification"),
    createdAt: responseString(notification, "createdAt", "notification"),
    title: responseString(notification, "title", "notification"),
    body: responseString(notification, "body", "notification"),
    ...(notification.urgency === "critical" || notification.urgency === "normal"
      ? { urgency: notification.urgency }
      : {}),
    ...(typeof notification.channelId === "string"
      ? { channelId: notification.channelId }
      : {}),
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
  if (
    !hasExactKeys(value, ["schemaVersion", "notifications"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.notifications)
  ) {
    throw new Error("notification list is invalid");
  }
  return value.notifications.map(decodeNotification);
}

export function decodeStartConnectionResult(
  input: unknown,
): ClientStartConnectionResult {
  const value = decodeStartConnectionResultV1(input);
  if (value.status === "ready") return value;
  return {
    ...value,
    redirectUrl: decodeExternalAuthorizationUrl(value.redirectUrl),
  };
}

export function decodeAcknowledgement(input: unknown): void {
  const value = responseRecord(input, "acknowledgement");
  if (
    !hasExactKeys(value, ["schemaVersion", "status"]) ||
    value.schemaVersion !== 1 ||
    value.status !== "acknowledged"
  ) {
    throw new Error("acknowledgement is invalid");
  }
}

export function decodeRevocationResult(input: unknown): void {
  decodeRevokeConnectionResultV1(input);
}

export interface ClientSlotRegistration {
  slot: string;
  order: number;
  component: Component;
}

export interface ClientSurfaceRegistration {
  id: string;
  title: string;
  component: Component;
  /**
   * Where the shell renders the surface. "overlay" (the default) floats the
   * surface over the workspace; "panel" swaps it into the right panel in place
   * of that panel's normal content, so the surrounding chrome stays put.
   */
  placement?: "overlay" | "panel";
}

export interface ClientSurfaceRegistry {
  readonly active: ComputedRef<ClientSurfaceRegistration | undefined>;
  readonly activeId: Readonly<Ref<string | undefined>>;
  register(registration: ClientSurfaceRegistration): () => void;
  has(id: string): boolean;
  open(id: string): void;
  close(): void;
}

export const clientSurfaceRegistryKey: InjectionKey<ClientSurfaceRegistry> =
  Symbol("frockbot.client-surfaces");

export interface ClientPluginContext {
  transport: AgentTransport;
  slot(registration: ClientSlotRegistration): () => void;
  provide<T>(key: InjectionKey<T>, value: T): () => void;
  inject<T>(key: InjectionKey<T>): T;
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
      inject: (key) => this.injectProvider(key),
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
    if (this.providers.some((registration) => registration.key === key)) {
      throw new Error("client provider is already registered");
    }
    const registration: ProviderRegistration = { key, value };
    this.providers.push(registration);
    return () => {
      const index = this.providers.indexOf(registration);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  private injectProvider<T>(key: InjectionKey<T>): T {
    const registration = this.providers.find(
      (candidate) => candidate.key === key,
    );
    if (!registration) {
      throw new Error("required client provider is unavailable");
    }
    return registration.value as T;
  }
}
