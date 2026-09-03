/**
 * `Applet`: the base class an Applet's `server.ts` extends.
 *
 * The authoring surface is deliberately three things — `tables`, `tools`, and
 * `this.db` — plus an optional `migrate`. Everything below them (DDL, the
 * change log, the socket protocol, tool declarations, broadcast) is the SDK's
 * and is versioned once.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AppletDurableObjectState,
  AppletHibernatableWebSocket,
} from "cloudflare:workers";

import {
  APPLET_CONTRACT_VERSION,
  encodeFrame,
  type AppletChangeV1,
  type AppletViewerV1,
} from "../protocol/index.js";
import {
  AppletValidationError,
  assertTableNames,
  decodeToolInput,
  jsonSchemaFromColumns,
  type Column,
  type ColumnsShape,
  type InsertOf,
  type JsonSchemaObject,
  type PatchOf,
  type RowOf,
  type TableDefinition,
  type TablesShape,
} from "../schema/index.js";
import { AppletProtocolServer, type AppletPeer } from "./session.js";
import { AppletStore } from "./store.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface AppletToolDeclarationV1 {
  name: string;
  description: string;
  input: JsonSchemaObject;
}

export interface AppletHealthV1 {
  contract: 1;
  tools: AppletToolDeclarationV1[];
  schemaRevision: number;
}

type ColumnValue<C> = C extends Column<infer V, boolean, boolean> ? V : never;

/** The argument a tool handler receives, derived from its declared input. */
export type ToolInputOf<TInput extends ColumnsShape> = {
  [K in keyof TInput]: ColumnValue<TInput[K]>;
};

export interface AppletToolSpec<TInput extends ColumnsShape> {
  description: string;
  input: TInput;
}

export interface AppletTool<TInput extends ColumnsShape = ColumnsShape> {
  readonly description: string;
  readonly input: TInput;
  readonly handler: (input: ToolInputOf<TInput>) => Promise<string> | string;
}

/** A tool with its input type erased, as the `tools` record holds it. */
export interface AnyAppletTool {
  readonly description: string;
  readonly input: ColumnsShape;
  readonly handler: (input: never) => Promise<string> | string;
}

export interface AppletTableApi<T extends TableDefinition> {
  /** Insert a row; the key is generated when the insert omits it. */
  insert(values: InsertOf<T>): RowOf<T>;
  /** Patch a row; `undefined` when no row has that key. */
  update(key: string, patch: PatchOf<T>): RowOf<T> | undefined;
  /** Remove a row; `false` when no row had that key. */
  delete(key: string): boolean;
  /** Every row, or those whose columns all equal `filter`. */
  select(filter?: PatchOf<T>): Array<RowOf<T>>;
}

export type AppletDb<TTables extends TablesShape> = {
  [K in keyof TTables]: AppletTableApi<TTables[K]>;
};

interface ViewerAttachment {
  viewer: AppletViewerV1;
  /** Set once the socket has been sent its snapshot or catch-up. */
  synced: boolean;
}

/**
 * `TTables` is the declared schema, supplied by the subclass:
 *
 * ```ts
 * const tables = { todos: table({ id: t.id(), title: t.text() }) };
 * export default class TodoApplet extends Applet<typeof tables> {
 *   tables = tables;
 * }
 * ```
 *
 * It is a type parameter rather than `this["tables"]` so that a tool handler
 * can reach `this.db` without the class's own type becoming circular.
 */
export abstract class Applet<
  TTables extends TablesShape = TablesShape,
  Env = unknown,
> extends DurableObject<Env> {
  /** Declared once with `table()`; the SDK derives DDL, wire, and types. */
  abstract readonly tables: TTables;

  /** Declared with `this.tool(...)`; `health()` reports them to the kernel. */
  readonly tools: Record<string, AnyAppletTool> = {};

  #store?: AppletStore;
  #ready?: Promise<void>;
  #revision = 0;
  #pending: AppletChangeV1[] = [];
  #db?: AppletDb<TTables>;

  /**
   * Runs when a mount finds storage written under an earlier declared shape.
   * `from` is the previous schema revision; new columns have already been
   * added. Backfill or rewrite here and throw to fail the mount.
   */
  async migrate(_from: number): Promise<void> {}

  /** Declare a tool. Call it in the `tools` field initializer. */
  protected tool<TInput extends ColumnsShape>(
    spec: AppletToolSpec<TInput>,
    handler: (input: ToolInputOf<TInput>) => Promise<string> | string,
  ): AppletTool<TInput> {
    if (
      typeof spec?.description !== "string" ||
      spec.description.length === 0
    ) {
      throw new Error("A tool needs a description");
    }
    if (spec.description.length > 1_024) {
      throw new Error("A tool description may be at most 1024 characters");
    }
    return { description: spec.description, input: spec.input ?? {}, handler };
  }

  /** Typed access to the Applet's own tables. */
  protected get db(): AppletDb<TTables> {
    this.#db ??= this.#buildDb();
    return this.#db;
  }

  #buildDb(): AppletDb<TTables> {
    const applet = this;
    const api: Record<string, AppletTableApi<TableDefinition>> = {};
    for (const name of Object.keys(this.tables)) {
      api[name] = {
        insert: (values) =>
          applet.#write(() =>
            applet
              .#requireStore()
              .insert(name, values as Record<string, unknown>),
          ).row as never,
        update: (key, patch) => {
          const change = applet.#write(() =>
            applet
              .#requireStore()
              .update(name, key, patch as Record<string, unknown>),
          );
          return change?.row as never;
        },
        delete: (key) =>
          applet.#write(() => applet.#requireStore().delete(name, key)) !==
          undefined,
        select: (filter) =>
          applet
            .#requireStore()
            .select(
              name,
              filter as Record<string, unknown> | undefined,
            ) as never,
      };
    }
    return api as AppletDb<TTables>;
  }

  #write<T extends AppletChangeV1 | undefined>(closure: () => T): T {
    const change = this.ctx.storage.transactionSync(closure);
    if (change) this.#pending.push(change);
    return change;
  }

  #requireStore(): AppletStore {
    if (!this.#store) {
      throw new Error("The Applet's storage is not ready yet; await a handler");
    }
    return this.#store;
  }

  /** Idempotent: DDL on first use, then `migrate` when the shape has moved. */
  protected ready(): Promise<void> {
    this.#ready ??= this.ctx.blockConcurrencyWhile(async () => {
      assertTableNames(this.tables);
      for (const name of Object.keys(this.tools)) {
        if (!TOOL_NAME.test(name))
          throw new Error(`Tool name "${name}" is invalid`);
      }
      const store = new AppletStore(this.ctx.storage.sql, this.tables);
      const state = this.ctx.storage.transactionSync(() =>
        store.ensureSchema(),
      );
      this.#store = store;
      this.#revision = state.revision;
      if (state.changed && state.previousRevision > 0) {
        await this.migrate(state.previousRevision);
      }
    });
    return this.#ready;
  }

  /** What the kernel calls after a mount to admit the generation. */
  async health(): Promise<AppletHealthV1> {
    await this.ready();
    return {
      contract: APPLET_CONTRACT_VERSION,
      tools: Object.entries(this.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        input: jsonSchemaFromColumns(tool.input),
      })),
      schemaRevision: this.#revision,
    };
  }

  /** What an Applet tool call from a Bot's Turn routes to. */
  async invokeTool(name: string, input: unknown): Promise<string> {
    await this.ready();
    const tool = this.tools[name];
    if (!tool) throw new AppletValidationError(`Unknown tool "${name}"`);
    const decoded = decodeToolInput(tool.input, input);
    const result = await tool.handler(decoded as never);
    this.#flush();
    if (typeof result !== "string") {
      throw new Error(`Tool "${name}" must return a string`);
    }
    return result;
  }

  /** The viewer socket. The kernel forwards an already-authorised upgrade. */
  async fetch(request: Request): Promise<Response> {
    await this.ready();
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const viewer: AppletViewerV1 = {
      id:
        request.headers.get("x-applet-viewer") ??
        url.searchParams.get("viewer") ??
        "viewer",
      canWrite:
        (request.headers.get("x-applet-can-write") ??
          url.searchParams.get("canWrite") ??
          "true") !== "false",
    };
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      viewer,
      synced: false,
    } satisfies ViewerAttachment);
    this.#protocol().greet(this.#peer(server));
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: unknown });
  }

  /**
   * The mounted generation, reported in `hello` so a client can tell a code
   * change from a reconnect. The kernel names the Durable Object after it.
   */
  protected get generationId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  async webSocketMessage(
    socket: AppletHibernatableWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ready();
    this.#protocol().receive(
      this.#peer(socket),
      typeof message === "string" ? message : new TextDecoder().decode(message),
    );
  }

  async webSocketClose(
    socket: AppletHibernatableWebSocket,
    code: number,
    closeReason: string,
  ): Promise<void> {
    // 1006 is never a valid code to echo back.
    socket.close(code === 1006 ? 1000 : code, closeReason);
  }

  /**
   * A hibernating socket seen as a peer. The viewer identity and the "already
   * sent a snapshot" flag live in the socket's attachment, which is what
   * survives hibernation; no session state is held in memory.
   */
  #peer(socket: AppletHibernatableWebSocket): AppletPeer {
    const attachment = (socket.deserializeAttachment() ?? {
      viewer: { id: "viewer", canWrite: true },
      synced: false,
    }) as ViewerAttachment;
    return {
      viewer: attachment.viewer,
      get synced() {
        return attachment.synced;
      },
      set synced(value: boolean) {
        attachment.synced = value;
        socket.serializeAttachment(attachment);
      },
      send: (frame) => socket.send(encodeFrame(frame)),
      close: (code, reason) => socket.close(code, reason),
    };
  }

  #protocol(): AppletProtocolServer {
    return new AppletProtocolServer(this.#requireStore(), {
      generationId: this.generationId,
      schemaRevision: this.#revision,
      transaction: (closure) => this.ctx.storage.transactionSync(closure),
      peers: () => this.ctx.getWebSockets().map((socket) => this.#peer(socket)),
    });
  }

  /** Send changes made outside a client transaction (a tool call) to viewers. */
  #flush(): void {
    if (this.#pending.length === 0) return;
    const changes = this.#pending;
    this.#pending = [];
    this.#protocol().broadcastChanges(changes);
  }

  /** Exposed for the kernel's delete path; storage goes with the facet. */
  protected get state(): AppletDurableObjectState {
    return this.ctx;
  }
}
