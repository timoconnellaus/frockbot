/**
 * `@frockbot/applet-sdk/plugin` — what a Plugin's `plugin.ts` is written
 * against (ADR 0026).
 *
 * A Plugin is one ESM module with no imports of its own. It exports `tools`
 * and `execute`, and may export `hooks`, `services` and `triggers`. The
 * kernel's generated index imports the built module, checks these exports
 * against the Plugin's `plugin.json` once at mount, and hands every call a
 * narrow `ctx` naming only what that Plugin declared it may do.
 *
 * These declarations are types only. They mirror `core/contracts/isolate.ts`
 * member for member — `BOT_ISOLATE_CONTEXT_KEYS_V1` is the list this file's
 * `PluginContext` is tested against — so a Plugin that type-checks here sees
 * the `ctx` the wrapper actually builds.
 */

/** A JSON Schema object, as a tool's `inputSchema`. */
export type JsonSchema = { [key: string]: unknown };

/** The loop events a Plugin may hook, in the order the loop raises them. */
export type PluginHookEvent =
  | "system-prompt/assemble"
  | "agent/tool-exposure"
  | "agent/request"
  | "tools/pre-execute"
  | "tools/post-execute"
  | "agent/turn-stopping";

/**
 * The grants a Plugin may declare in `plugin.json`, in the kernel's order.
 * `storage`, `http`, `schedule`, `ai`, `memory` and `workspace` each open one
 * member of `ctx`; `files` and `computer` are declared to the authority and
 * open nothing here.
 */
export type PluginGrant =
  | "storage"
  | "http"
  | "schedule"
  | "ai"
  | "files"
  | "memory"
  | "workspace"
  | "computer";

/** One tool the Plugin offers the Bot. Its name must be in `plugin.json` too. */
export interface PluginTool {
  /** `^[a-z][a-z0-9_]{0,63}$`, unique within the Plugin. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when a retry under the same input is harmless. Default false. */
  idempotent?: boolean;
  /**
   * Which Turn types may call it. Absent means every Turn type. Subagent
   * roles narrow it further.
   */
  admission?: { turnTypes: string[]; subagentRoles?: string[] };
}

/** A capability call the authority could not serve. Never an exception. */
export interface CapabilityFailure {
  status: "unavailable";
  reason: string;
}

export interface StorageEntry {
  key: string;
  value: unknown;
}

/**
 * The `storage` grant: a key-value store scoped to this Plugin and this Bot.
 * Keys are `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`; a value serializes to at
 * most 64 KiB.
 */
export interface PluginStorage {
  get(request: {
    key: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  put(request: {
    key: string;
    value: unknown;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  delete(request: {
    key: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  list(request: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<
    | { status: "available"; entries: StorageEntry[]; cursor?: string }
    | CapabilityFailure
  >;
}

/** This Plugin's settings values for this Bot, as the User set them. */
export interface PluginSettings {
  read(): Promise<
    { status: "available"; values: Record<string, unknown> } | CapabilityFailure
  >;
}

/** One Connection the Bot holds, as `capabilities.list()` names it. */
export interface ConnectionSummary {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  generation: string;
  safeMetadata: Record<string, unknown>;
}

/** The Bot's configured model, as `capabilities.list()` names it. */
export interface ModelBindingSummary {
  connectionId: string;
  packageId: string;
  provider: string;
  providerModelId: string;
  connectionGeneration: string;
  catalogGeneration?: string;
}

/** What the Bot holds right now. Nothing here widens what the Plugin may do. */
export interface CapabilityList {
  status: "available";
  connections: ConnectionSummary[];
  model?: ModelBindingSummary;
  memory: boolean;
  workspace: boolean;
  schedule: true;
}

/** An opaque, short-lived reference to a Connection — never its credential. */
export interface ConnectionLease {
  status: "available";
  leaseId: string;
  connectionId: string;
  generation: string;
  expiresAt: string;
}

/** One streamed model event. `text-delta` carries the text a reply grows by. */
export type ModelStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: string; [key: string]: unknown };

/** The `ai` grant: the Bot's own configured model, never another. */
export interface PluginModel {
  invoke(request: { [key: string]: unknown }): Promise<
    | {
        status: "streaming";
        requestId: string;
        events: AsyncIterable<ModelStreamEvent>;
      }
    | CapabilityFailure
  >;
}

export type MemoryScope = "bot" | "user" | "project";
export type MemoryTier = "profile" | "log" | "note";

/** The `memory` grant. */
export interface PluginMemory {
  read(request: {
    scope: MemoryScope;
    projectId?: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  write(request: {
    scope: MemoryScope;
    projectId?: string;
    tier?: MemoryTier;
    fact: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  forget(request: {
    scope: MemoryScope;
    projectId?: string;
    tier?: MemoryTier;
    fact: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
}

/** A Workspace root without a User id; the authority supplies its own. */
export type WorkspaceRoot =
  | { kind: "bot-instructions"; botId: string }
  | { kind: "user-instructions" }
  | { kind: "package-declared"; packageId: string; rootId: string };

export interface WorkspacePath {
  root: WorkspaceRoot;
  path: string;
}

export type WorkspaceOutcome =
  { status: "available"; value: unknown } | CapabilityFailure;

/** The `workspace` grant. */
export interface PluginWorkspace {
  read(path: WorkspacePath): Promise<WorkspaceOutcome>;
  list(request: {
    root: WorkspaceRoot;
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<WorkspaceOutcome>;
  stat(path: WorkspacePath): Promise<WorkspaceOutcome>;
  write(request: {
    path: WorkspacePath;
    bytes: Uint8Array;
    expectedGenerationId: string | null;
    mediaType?: string;
  }): Promise<WorkspaceOutcome>;
  delete(request: {
    path: WorkspacePath;
    expectedGenerationId: string;
  }): Promise<WorkspaceOutcome>;
}

/**
 * The `ctx` every tool call and hook receives.
 *
 * Three context keys — `user`, `bot`, `session` — and one member per grant
 * the Plugin declared. A grant the Plugin did not ask for is absent from
 * `ctx` entirely, which is why every grant member is optional here.
 */
export interface PluginContext {
  /** The tool being executed; absent inside a hook. */
  readonly tool?: string;
  /** The hook event being raised; absent inside a tool call. */
  readonly event?: PluginHookEvent;
  readonly user: { readonly userId: string };
  readonly bot: { readonly botId: string };
  readonly session: {
    readonly sessionId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly generationId: string;
  };
  /** This Plugin's id. */
  readonly packageId: string;
  /** How long this call may run, in milliseconds. */
  readonly deadlineMs: number;
  /** The names of the bindings the worker was given. */
  readonly bindings: string[];
  readonly capabilities: {
    list(): Promise<CapabilityList | CapabilityFailure>;
  };
  /**
   * The services other Plugins in the worker provide and this Plugin declared
   * it consumes, by service name. Empty for a Plugin that consumes nothing.
   */
  readonly services: Record<string, unknown>;
  readonly settings: PluginSettings;
  /** The `ai` grant. */
  readonly model?: PluginModel;
  /** The `memory` grant. */
  readonly memory?: PluginMemory;
  /** The `workspace` grant. */
  readonly workspace?: PluginWorkspace;
  /** The `http` grant: a named Connection, credential attached server-side. */
  readonly connection?: (
    connectionId: string,
  ) => Promise<ConnectionLease | CapabilityFailure>;
  /** The `schedule` grant: a durable Routine operation attributed to this call. */
  readonly schedule?: (request: {
    callId: string;
    input: unknown;
  }) => Promise<
    | { status: "completed"; content: string; isError: boolean }
    | CapabilityFailure
  >;
  /** The `storage` grant. */
  readonly storage?: PluginStorage;
}

/** `ctx` inside `execute`: the tool is named, no event is. */
export interface PluginExecutionContext extends PluginContext {
  readonly tool: string;
  readonly event?: never;
}

/** `ctx` inside a hook: the event is named, no tool is. */
export interface PluginHookContext extends PluginContext {
  readonly tool?: never;
  readonly event: PluginHookEvent;
}

/** One step of the loop, as a hook payload carries it. */
export interface StepSnapshot {
  step: number;
  [key: string]: unknown;
}

/** One tool as the model is offered it. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  [key: string]: unknown;
}

/**
 * What each hook receives, and the one value it may replace. A hook returns
 * `undefined` to leave the value alone, or the replacement — the *whole*
 * value, not a patch. A later Plugin sees an earlier Plugin's replacement.
 * `agent/turn-stopping` is a notification: its return is ignored.
 */
export interface PluginHookPayloads {
  "system-prompt/assemble": {
    context: { [key: string]: unknown };
    assembly: { [key: string]: unknown };
  };
  "agent/tool-exposure": { step: StepSnapshot; tools: ToolSchema[] };
  "agent/request": { step: StepSnapshot; request: { [key: string]: unknown } };
  "tools/pre-execute": {
    call: { [key: string]: unknown };
    context: { [key: string]: unknown };
    preparation: { [key: string]: unknown };
  };
  "tools/post-execute": {
    call: { [key: string]: unknown };
    context: { [key: string]: unknown };
    result: { [key: string]: unknown };
  };
  "agent/turn-stopping": { agent: { [key: string]: unknown }; turn: number };
}

export interface PluginHookReplacements {
  "system-prompt/assemble": PluginHookPayloads["system-prompt/assemble"]["assembly"];
  "agent/tool-exposure": ToolSchema[];
  "agent/request": PluginHookPayloads["agent/request"]["request"];
  "tools/pre-execute": PluginHookPayloads["tools/pre-execute"]["preparation"];
  "tools/post-execute": PluginHookPayloads["tools/post-execute"]["result"];
  "agent/turn-stopping": never;
}

export type PluginHook<Event extends PluginHookEvent> = (
  payload: PluginHookPayloads[Event],
  ctx: PluginHookContext,
) =>
  | Promise<PluginHookReplacements[Event] | undefined | void>
  | PluginHookReplacements[Event]
  | undefined
  | void;

export type PluginHooks = {
  [Event in PluginHookEvent]?: PluginHook<Event>;
};

/**
 * One delivery handed to a trigger: the posted body as it arrived, and the
 * headers lower-cased with the door's own credential removed.
 */
export interface PluginTriggerDelivery {
  headers: Record<string, string>;
  body: string;
}

/** A trigger's refusal: the Routine does not fire, and the receipt says why. */
export interface PluginTriggerDrop {
  drop: true;
  reason?: string;
}

/**
 * A trigger handler: a non-empty string fires the Routine with that text.
 * A `{ drop: true }` — or nothing at all — leaves it unfired.
 */
export type PluginTrigger = (
  delivery: PluginTriggerDelivery,
  ctx: PluginContext,
) =>
  | Promise<string | PluginTriggerDrop | undefined | void>
  | string
  | PluginTriggerDrop
  | undefined
  | void;

/** Every trigger the module exports, by the name `plugin.json` declares. */
export type PluginTriggers = Record<string, PluginTrigger>;

/**
 * A tool call's answer. A string is handed to the Bot as it is; anything else
 * is JSON-serialized. Throw to answer with an error the Bot can read — the
 * wrapper turns a thrown `Error` into an error result with its message.
 */
export type ToolResult = string | unknown;

/**
 * The module shape `plugin.ts` must satisfy. There is no default export —
 * export each member by name:
 *
 * ```ts
 * export const tools: PluginTool[] = [...];
 * export const execute: PluginExecute = async (tool, input, ctx) => {...};
 * export const hooks: PluginHooks = {...};
 * ```
 */
export type PluginExecute = (
  tool: string,
  input: unknown,
  ctx: PluginExecutionContext,
) => Promise<ToolResult> | ToolResult;

export interface PluginModule {
  tools: PluginTool[];
  execute: PluginExecute;
  hooks?: PluginHooks;
  /** Values other Plugins that `consume` a service of the same name receive. */
  services?: Record<string, unknown>;
  triggers?: PluginTriggers;
}
