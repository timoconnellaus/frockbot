/**
 * `@frockbot/applet-sdk/module`: what a Plugin's device module is written
 * against (ADR 0037).
 *
 * A module is `modules/<id>.ts` in the Plugin's source. The desktop runs it in
 * its own Deno process, which can read only the paths its descriptor's `read`
 * names and reach only the addresses its `net` names. It may use Node's
 * built-in modules (`node:fs`, `node:sqlite`, …), `fetch` and `WebSocket` like
 * any other program, within those limits.
 *
 * A module exports its `calls`, one function for each call the descriptor
 * declares, and may export `start`, which runs for as long as the app does and
 * is where a module holds a connection and emits events.
 */

/** One event the module sends to the cloud, to fire the Plugin's triggers. */
export interface ModuleEmitOptions {
  /**
   * The source's own id for this occurrence. A replay under the same key is
   * the same event, so a reconnect never fires a Routine twice.
   */
  key: string;
}

/** What the host hands a module. */
export interface ModuleContext {
  /** Sends one event to the cloud. `event` must be one the descriptor names. */
  emit(
    event: string,
    payload: unknown,
    options: ModuleEmitOptions,
  ): Promise<void>;
  /** The last key the cloud acknowledged for `event`, to catch up from. */
  lastKey(event: string): Promise<string | undefined>;
  /** A line the Bot reads back with `plugin_module_reports`. */
  log(level: "log" | "error", text: string): void;
  /** A small key-value store on this device, for the module alone. */
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Runs an AppleScript against an application the descriptor names. */
  appleEvents: {
    run(bundleId: string, script: string): Promise<string>;
  };
  /** Aborts when the host stops the module. */
  signal: AbortSignal;
}

/** One call the Plugin's cloud code may make. Its answer must be JSON. */
export type ModuleCall = (input: unknown, context: ModuleContext) => unknown;

export type ModuleCalls = Record<string, ModuleCall>;

/** Runs for as long as the app does; resolve or throw to stop. */
export type ModuleStart = (context: ModuleContext) => Promise<void> | void;
