/**
 * `@frockbot/applet-sdk/client` — everything an Applet's `ui.tsx` imports.
 *
 * ```tsx
 * import { createApplet, newId } from "@frockbot/applet-sdk/client";
 * import type TodoApplet from "./server";
 *
 * const applet = createApplet<TodoApplet>();
 *
 * export default function App() {
 *   const { data: todos } = applet.useLiveQuery((q) =>
 *     q.from({ t: applet.tables.todos }).orderBy(({ t }) => t.createdAt),
 *   );
 * }
 * ```
 *
 * The page never opens the socket itself: the host sends an `init` postMessage
 * carrying the theme tokens and a short-lived viewer token, and `createApplet`
 * connects from that. `connect(init)` is the same path, called by hand, which
 * is what `applet dev` and the tests use.
 */

import type { Collection } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { RowOf, TablesShape } from "../schema/index.js";
import { createAppletCollection, type AppletRow } from "./collections.js";
import {
  AppletTransport,
  type AppletInitV1,
  type AppletState,
  type AppletStatus,
  type AppletTransportOptions,
} from "./transport.js";

export type {
  AppletInitV1,
  AppletState,
  AppletStatus,
  AppletSocket,
  AppletSocketFactory,
  AppletTransportOptions,
} from "./transport.js";
export { AppletTransport } from "./transport.js";
export { useLiveQuery } from "@tanstack/react-db";
export { eq, gt, gte, ilike, like, lt, lte, not, or, and } from "@tanstack/db";

/** A fresh row key. Client inserts must carry one; server inserts need not. */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Render the Applet. The SDK owns this so an Applet never imports `react-dom`
 * — one fewer specifier to remember, and the linter can keep the import list
 * to three entries.
 */
export function mount(element: ReactNode): void {
  const existing = document.getElementById("applet-root");
  const container =
    existing ?? document.body.appendChild(document.createElement("div"));
  createRoot(container).render(element);
}

export type AppletCollections<TTables extends TablesShape> = {
  [K in keyof TTables]: Collection<RowOf<TTables[K]> & AppletRow, string>;
};

export interface AppletClient<TTables extends TablesShape> {
  /** One TanStack DB collection per declared table, created on first access. */
  readonly tables: AppletCollections<TTables>;
  readonly useLiveQuery: typeof useLiveQuery;
  /** Connection status, viewer identity, and the mounted generation. */
  useApplet(): AppletState;
  /** Open the socket by hand; the host's `init` message does this for you. */
  connect(init: AppletInitV1): void;
  close(): void;
}

export interface CreateAppletOptions extends AppletTransportOptions {
  /**
   * Listen for the host's `init` postMessage and connect from it.
   * Defaults to true in a browser and false anywhere else.
   */
  autoConnect?: boolean;
}

/** The host's `init`, with the fields an Applet page needs. */
export interface AppletHostInitV1 {
  themeTokens: Record<string, string>;
  applet: AppletInitV1;
}

function decodeHostInit(data: unknown): AppletHostInitV1 | undefined {
  if (!data || typeof data !== "object") return undefined;
  const message = data as Record<string, unknown>;
  if (message.schemaVersion !== 1 || message.type !== "init") return undefined;
  const applet = message.applet;
  const tokens = message.themeTokens;
  if (!applet || typeof applet !== "object") return undefined;
  if (!tokens || typeof tokens !== "object") return undefined;
  const value = applet as Record<string, unknown>;
  if (
    typeof value.socketUrl !== "string" ||
    typeof value.token !== "string" ||
    typeof value.generationId !== "string"
  ) {
    return undefined;
  }
  const themeTokens: Record<string, string> = {};
  for (const [key, entry] of Object.entries(
    tokens as Record<string, unknown>,
  )) {
    if (typeof entry === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(key)) {
      themeTokens[key] = entry;
    }
  }
  return {
    themeTokens,
    applet: {
      socketUrl: value.socketUrl,
      token: value.token,
      generationId: value.generationId,
    },
  };
}

/** Paint the host's semantic tokens onto the page as `--frockbot-*`. */
export function applyThemeTokens(tokens: Record<string, string>): void {
  if (typeof document === "undefined") return;
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(`--frockbot-${name}`, value);
  }
}

/** Subscribe to the host's `init` message. Returns an unsubscribe function. */
export function listenForAppletInit(
  handler: (init: AppletHostInitV1) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const init = decodeHostInit(event.data);
    if (init) handler(init);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

export function createApplet<TServer extends { tables: TablesShape }>(
  options: CreateAppletOptions = {},
): AppletClient<TServer["tables"]> {
  const { autoConnect, ...transportOptions } = options;
  const transport = new AppletTransport(transportOptions);
  const collections = new Map<string, Collection<AppletRow, string>>();

  const tables = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      let collection = collections.get(property);
      if (!collection) {
        collection = createAppletCollection(property, transport);
        collections.set(property, collection);
      }
      return collection;
    },
    has: () => true,
    ownKeys: () => [...collections.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }) as AppletCollections<TServer["tables"]>;

  if (autoConnect ?? typeof window !== "undefined") {
    listenForAppletInit((init) => {
      applyThemeTokens(init.themeTokens);
      transport.connect(init.applet);
    });
  }

  return {
    tables,
    useLiveQuery,
    useApplet: () =>
      useSyncExternalStore(
        (listener) => transport.subscribe(listener),
        () => transport.state,
        () => transport.state,
      ),
    connect: (init) => transport.connect(init),
    close: () => transport.close(),
  };
}
