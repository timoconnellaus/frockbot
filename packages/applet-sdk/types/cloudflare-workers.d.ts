/**
 * The only part of the Cloudflare programming model the SDK names.
 *
 * ADR 0022 records the ceiling deliberately: an Applet is a Durable Object with
 * alarms and hibernating sockets, and no adapter hides that. What this file
 * does is keep the surface to the handful of members `server/` actually uses,
 * so an Applet author never types a binding name and the SDK type-checks
 * without `@cloudflare/workers-types` in scope. It lives outside `src/` so a
 * consumer that already has the real Workers types cannot see two declarations
 * of the same module.
 */

declare module "cloudflare:workers" {
  export interface AppletSqlCursor {
    toArray(): Array<Record<string, unknown>>;
  }

  export interface AppletSqlStorageHandle {
    exec(query: string, ...bindings: unknown[]): AppletSqlCursor;
  }

  export interface AppletDurableObjectStorage {
    readonly sql: AppletSqlStorageHandle;
    transactionSync<T>(closure: () => T): T;
    deleteAll(): Promise<void>;
  }

  export interface AppletHibernatableWebSocket {
    send(message: string): void;
    close(code?: number, reason?: string): void;
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
  }

  export interface AppletDurableObjectState {
    readonly id: { toString(): string; readonly name?: string };
    readonly storage: AppletDurableObjectStorage;
    acceptWebSocket(socket: AppletHibernatableWebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): AppletHibernatableWebSocket[];
    blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T>;
  }

  export class DurableObject<Env = unknown> {
    constructor(ctx: AppletDurableObjectState, env: Env);
    protected readonly ctx: AppletDurableObjectState;
    protected readonly env: Env;
  }
}

declare const WebSocketPair: {
  new (): {
    0: import("cloudflare:workers").AppletHibernatableWebSocket;
    1: import("cloudflare:workers").AppletHibernatableWebSocket;
  };
};
