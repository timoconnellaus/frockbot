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
}

export interface ClientNotificationIntent {
  notificationId: string;
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

export interface ClientStartConnectionResult {
  connectionId: string;
  redirectUrl: string;
  expiresAt: string;
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
    botId: string;
    alias?: string;
  }): Promise<ClientStartConnectionResult>;
  revokeConnection?(packageId: string, connectionId: string): Promise<void>;
  listNotifications?(): Promise<ClientNotificationIntent[]>;
  acknowledgeNotification?(notificationId: string): Promise<void>;
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
