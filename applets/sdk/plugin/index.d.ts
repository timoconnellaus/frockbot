/**
 * `@frockbot/applet-sdk/plugin` — what a Plugin's `plugin.ts` is written
 * against (ADR 0026).
 *
 * A Plugin is one ESM module with no imports of its own. It exports `tools`
 * and `execute`, and may export `hooks`, `services`, `triggers`, `views`,
 * `cards` and `modelProviders` (`PluginModule`). The kernel's generated index
 * imports the built module, checks these exports against the Plugin's
 * `plugin.json` once at mount, and hands every call a narrow `ctx` naming
 * only what that Plugin declared it may do.
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
  | "agent/turn-stopping"
  | "theme/assemble";

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
  | "computer"
  | "device";

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

/** One message in the normalized request a model provider is handed. */
export interface PluginModelMessage {
  role: "user" | "assistant" | "tool";
  [key: string]: unknown;
}

/**
 * One model request, normalized by the kernel: the same shape a Package's
 * provider receives, minus the Connection the host holds on the Plugin's
 * behalf.
 */
export interface PluginModelRequest {
  requestId: string;
  provider: string;
  model: string;
  system: string;
  messages: PluginModelMessage[];
  tools: { name: string; description: string; inputSchema: JsonSchema }[];
  responseFormat?: { type: string; [key: string]: unknown };
}

/**
 * One normalized stream event a provider answers with. The kernel decodes
 * every field strictly, so a provider that invents an event fails its call
 * rather than half-rendering a reply.
 */
export type PluginModelStreamEvent =
  | {
      type: "provider-state";
      /** Opaque provider content the kernel replays on later turns. */
      state: { [key: string]: unknown };
    }
  | { type: "text-delta"; text: string }
  | {
      /**
       * A heartbeat: real upstream bytes that are not the reply — a reasoning
       * model thinking, arguments still arriving. It reaches no one and shows
       * nothing; it is how a long stretch with no visible output is told
       * apart from a dead socket.
       */
      type: "progress";
    }
  | { type: "tool-call"; call: { id: string; name: string; input: unknown } }
  | {
      type: "usage";
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
      };
    }
  | { type: "response-format-note"; note: { [key: string]: unknown } }
  | { type: "structured-output-failure"; failure: { [key: string]: unknown } }
  | { type: "finish"; reason: "completed" | "tool-calls" | "max-tokens" }
  | {
      /**
       * The provider refused, in the Plugin's own words. The classification
       * tells the kernel's retry policy what to do: `permanent` is not
       * retried, `transient` is, and `unknown` takes the kernel's default.
       */
      type: "provider-failure";
      classification: "transient" | "permanent" | "unknown";
      reason: string;
      retryAfterMs?: number;
    };

/** What the host transport answers with. */
export type PluginModelTransportOutcome =
  | {
      status: "streaming";
      httpStatus: number;
      /** The provider's body, streamed. Decode it as the provider frames it. */
      body: ReadableStream<Uint8Array>;
    }
  | {
      status: "refused";
      httpStatus: number;
      /** The host's own words; an upstream error body is never forwarded. */
      reason: string;
      retryAfterMs?: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * The model transport a provider contribution may call, exactly once per
 * model call. The host resolves the Connection, sends to the one endpoint and
 * route the deployment serves the provider on, attaches the credential
 * server-side and streams the provider's bytes back. A Plugin never sees the
 * credential, cannot name a Connection or a destination, and cannot follow a
 * redirect.
 */
export type PluginModelTransport = (request: {
  /** The request body, exactly as the upstream should receive it. */
  body: string;
}) => Promise<PluginModelTransportOutcome>;

/** `ctx` inside one model call served by this Plugin's provider contribution. */
export interface PluginModelContext extends PluginContext {
  /** This call's one credentialed upstream call. */
  readonly modelTransport: PluginModelTransport;
}

/**
 * One model provider a Plugin serves (ADR 0032). The `id` is the provider
 * type a Bot's model selection names; the descriptor declares it too, with
 * the protocol version, the credential scheme and the endpoint the host
 * attaches them to, and the two are checked against each other at mount.
 */
export interface PluginModelProvider {
  /**
   * One model call: the kernel hands a normalized request and the Plugin
   * answers with normalized events, reached through `ctx.modelTransport`.
   */
  stream(
    request: PluginModelRequest,
    ctx: PluginModelContext,
  ): AsyncIterable<PluginModelStreamEvent>;
}

/** Every model provider the module serves, by provider id. */
export type PluginModelProviders = Record<string, PluginModelProvider>;

export type MemoryScope = "bot" | "user";
export type MemoryTier = "profile" | "log" | "note";

/** The `memory` grant. */
export interface PluginMemory {
  read(request: {
    scope: MemoryScope;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  write(request: {
    scope: MemoryScope;
    tier?: MemoryTier;
    fact: string;
  }): Promise<{ status: "available"; value: unknown } | CapabilityFailure>;
  forget(request: {
    scope: MemoryScope;
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
  /**
   * The credentialed transport, present exactly while this Plugin is serving
   * one of its model provider contributions. A tool call's `ctx` has none.
   */
  readonly modelTransport?: PluginModelTransport;
  /** The `memory` grant. */
  readonly memory?: PluginMemory;
  /** The `workspace` grant. */
  readonly workspace?: PluginWorkspace;
  /** The `http` grant: a named Connection, credential attached server-side. */
  readonly connection?: (
    connectionId: string,
  ) => Promise<ConnectionLease | CapabilityFailure>;
  /**
   * The `http` grant, second half: the deployment's own sender, sending for
   * this Bot. The Plugin holds no credential and names no provider; a
   * deployment that has bound no sender answers unavailable.
   */
  readonly email?: (request: {
    /**
     * The Approval whose decision authorizes this send. The kernel refuses a
     * send whose Approval is missing, undecided, denied, expired or already
     * spent, so one decision sends at most one message.
     */
    approvalId: string;
    /**
     * The Card that decision was given on. The Approval is bound to the
     * surface and to the values it was showing, so a send whose message is
     * not the one that was approved is refused.
     */
    surfaceId: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    /** The `Message-Id` this answers, when it answers one. */
    inReplyTo?: string;
  }) => Promise<
    | { status: "sent"; messageId: string; undelivered?: string[] }
    | CapabilityFailure
  >;
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

/** The kinds of Turn the kernel admits. */
export type TurnType = "chat" | "agent" | "automation" | "subagent";

/** The agent a hook is running inside, as a hook payload carries it. */
export interface AgentSnapshot {
  botId: string;
  agentId: string;
  sessionId: string;
  status: "idle" | "running" | "disposed";
}

/** One step of the loop, as a hook payload carries it. */
export interface StepSnapshot extends AgentSnapshot {
  compositionGenerationId: string;
  turn: number;
  step: number;
  turnType: TurnType;
  subagentRole?: string;
}

/**
 * One tool as the model is offered it. Exactly these three members: a tool
 * returned from `agent/tool-exposure` with any other member is refused.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** What the system prompt is being assembled for. */
export interface PromptAssemblyContext {
  sessionId: string;
  provider: string;
  model: string;
  turnType: TurnType;
  subagentRole?: string;
  /** The step being assembled (1-based) and the last step the loop will run. */
  step?: { current: number; max: number };
  /** The Turn's deadline and the assembly instant, Unix epoch milliseconds. */
  deadline?: { at: number; now: number };
}

/** The assembled system prompt: its text, and the sections it was built from. */
export interface PromptAssembly {
  text: string;
  sections: Array<{ id: string; text: string }>;
}

/** One tool call the model made. `input` is whatever the model sent. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** The call a tool hook is about, minus anything live. */
export interface ToolCallContext {
  botId: string;
  agentId: string;
  sessionId: string;
  compositionGenerationId: string;
  effectId: string;
  toolCall?: ToolCall;
  turnType: TurnType;
  subagentRole?: string;
}

/**
 * The durable root an attachment's bytes live in, as the kernel records it.
 * Unlike {@link WorkspaceRoot}, which a Plugin names and the authority
 * completes, this one carries the User id.
 */
export type AttachmentRoot =
  | { kind: "bot-instructions"; userId: string; botId: string }
  | { kind: "user-instructions"; userId: string }
  | { kind: "bot-memory"; userId: string; botId: string }
  | { kind: "user-memory"; userId: string }
  | {
      kind: "package-declared";
      userId: string;
      packageId: string;
      rootId: string;
    };

/** Where an attachment's bytes live: a durable root and a relative path. */
export interface AttachmentPath {
  root: AttachmentRoot;
  path: string;
}

/** A binary a tool produced, named by where it lives rather than by its bytes. */
export interface ToolAttachment {
  kind: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  workspacePath: AttachmentPath;
  contentHash: string;
  bytes: number;
  /** Resolved bytes, present only in memory for one model request. */
  dataBase64?: string;
}

/**
 * A tool's settled result, as the loop records it. Not {@link ToolResult},
 * which is what a Plugin's own `execute` answers with.
 */
export interface ToolCallResult {
  content: string;
  isError: boolean;
  /** The Turn ends once this result is recorded. */
  endsTurn?: boolean;
  attachments?: ToolAttachment[];
}

/**
 * Whether a call is ready to run or already answered. A hook may deny a ready
 * call with a result; it may not lift a denial or change the call.
 */
export type ToolPreparation =
  | { kind: "ready"; call: ToolCall; idempotent: boolean }
  | { kind: "denied"; call: ToolCall; result: ToolCallResult };

/** Provider content the kernel replays on later turns; opaque to a Plugin. */
export interface ModelReplayState {
  connectionId?: string;
  connectionGeneration?: string;
  provider: string;
  model: string;
  content: string;
}

/** One message in a model request. */
export type ModelMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      providerState?: ModelReplayState;
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
      attachments?: ToolAttachment[];
    };

/** The JSON Schema subset a structured response may be held to. */
export type StructuredOutputSchema =
  | {
      type: "object";
      properties?: Record<string, StructuredOutputSchema>;
      required?: string[];
      additionalProperties?: boolean;
      enum?: unknown[];
      title?: string;
      description?: string;
    }
  | {
      type: "array";
      items: StructuredOutputSchema;
      enum?: unknown[];
      title?: string;
      description?: string;
    }
  | {
      type: "string" | "number" | "boolean";
      enum?: unknown[];
      title?: string;
      description?: string;
    };

export type ModelResponseFormat =
  | { type: "json_schema"; name: string; schema: StructuredOutputSchema }
  | { type: "json" };

/** The Connection a request was admitted under. */
export interface ModelBinding {
  connectionId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

/**
 * One normalized model request. A hook may change `system`, `messages`,
 * `tools` and `responseFormat`; a replacement that changes `requestId`,
 * `provider`, `model` or `modelBinding` is refused.
 */
export interface ModelRequest {
  requestId: string;
  provider: string;
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  responseFormat?: ModelResponseFormat;
  modelBinding?: ModelBinding;
}

/** A Bot's look as the person picked it. */
export type BotLook = "inherit" | "studio" | "custom";

/** The named looks a theme document is compiled from. */
export type ThemeLook = "ink" | "paper" | "studio";

/** Every colour is `#rrggbb`. */
export interface ThemeSurfaces {
  window: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  onAccent: string;
}

export interface ThemeTokens {
  surfaces: ThemeSurfaces;
  type: "manrope" | "inter";
  bubbles: { bot: "plain" | "raised"; me: "accent" | "tint" };
}

/** Tokens that take over from `after`, a 24-hour `HH:MM` time of day. */
export interface ThemePhase {
  after: string;
  tokens: ThemeTokens;
}

/**
 * The closed document the client paints a Bot from. The kernel re-validates a
 * `theme/assemble` replacement and refuses one that has any other member,
 * uses `approval`, `billing`, `Stop` or `grants` as a key anywhere, puts
 * `text` under 4.5:1 against `window` or `surface`, `muted` under 3:1
 * against `window`, or `onAccent` under 4.5:1 against `accent`, or has more
 * than 24 `phases`. A refused document is charged to every Plugin that wraps
 * `theme/assemble`, and the Bot keeps its last good theme.
 */
export interface ThemeDocument {
  schemaVersion: 1;
  look: ThemeLook;
  tokens: ThemeTokens;
  phases?: ThemePhase[];
}

/**
 * What each hook receives, and the one value it may replace. A hook returns
 * `undefined` to leave the value alone, or the replacement — the *whole*
 * value, not a patch. A later Plugin sees an earlier Plugin's replacement.
 * `agent/turn-stopping` is a notification: it may not replace anything.
 */
export interface PluginHookPayloads {
  "system-prompt/assemble": {
    context: PromptAssemblyContext;
    assembly: PromptAssembly;
  };
  "agent/tool-exposure": { step: StepSnapshot; tools: ToolSchema[] };
  "agent/request": { step: StepSnapshot; request: ModelRequest };
  "tools/pre-execute": {
    call: ToolCall;
    context: ToolCallContext;
    preparation: ToolPreparation;
  };
  "tools/post-execute": {
    call: ToolCall;
    context: ToolCallContext;
    result: ToolCallResult;
  };
  "agent/turn-stopping": { agent: AgentSnapshot; turn: number };
  "theme/assemble": {
    document: ThemeDocument;
    look: BotLook;
    now: string;
    timezone: string;
  };
}

export interface PluginHookReplacements {
  "system-prompt/assemble": PromptAssembly;
  "agent/tool-exposure": ToolSchema[];
  "agent/request": ModelRequest;
  "tools/pre-execute": ToolPreparation;
  "tools/post-execute": ToolCallResult;
  "agent/turn-stopping": never;
  "theme/assemble": ThemeDocument;
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
 * One node of a section a Plugin renders on its card. The host draws it with
 * its own widgets; a Plugin ships no markup. `field` and `embed` nodes are
 * not accepted from a Plugin and are left out when the card is drawn.
 */
export type PluginViewNode =
  | {
      type: "text";
      text: string;
      style?: "body" | "heading" | "label" | "status";
    }
  | {
      type: "group";
      orientation: "row" | "column";
      title?: string;
      collapsed?: boolean;
      children: PluginViewNode[];
    }
  | {
      /**
       * A control. `actionId` names one of this Plugin's tools; pressing it
       * runs that tool with `input`, outside any Turn, and the section is
       * rendered again.
       */
      type: "action";
      actionId: string;
      label: string;
      style?: "primary" | "secondary" | "danger";
      input?: { [key: string]: unknown };
    }
  | {
      type: "list";
      empty?: string;
      rows: { id: string; node: PluginViewNode; selected?: boolean }[];
    };

/** What a view returns: the section's tree. Return nothing to show no section. */
export interface PluginViewDocument {
  root: PluginViewNode;
}

/**
 * What a `conversation.panel` view that names a `page` returns: the state its
 * page is handed, any JSON object of at most 64 KB.
 */
export type PluginPageState = { [key: string]: unknown };

/**
 * A view: renders one declared surface with the same `ctx` a tool call gets.
 * It returns the tree the host draws, or — for a view that names a `page` —
 * the page's state.
 */
export type PluginView = (
  ctx: PluginContext,
) =>
  | Promise<PluginViewDocument | PluginPageState | undefined | void>
  | PluginViewDocument
  | PluginPageState
  | undefined
  | void;

/**
 * One A2UI message a Card is made of: the envelope plus exactly one of
 * `createSurface`, `updateComponents`, `updateDataModel` or `deleteSurface`.
 * The kernel decodes and bounds it, so it is carried loosely here.
 */
export interface CardMessage {
  version: "v1.0";
  [key: string]: unknown;
}

/** What a card's `render` is handed: the surface the kernel minted and the Bot's values. */
export interface PluginCardRender {
  /** The kernel's own surface id. A Plugin never chooses one. */
  surfaceId: string;
  /** The values the Bot sent, already validated against the card's `dataSchema`. */
  data: { [key: string]: unknown };
}

/** What a card action handler is handed: the press, as the person made it. */
export interface PluginCardPress {
  /** The card this press is on — the one the pressed surface was drawn from. */
  cardId: string;
  surfaceId: string;
  /** The `<action>` half of the `plugin/<pluginId>/<action>` that was pressed. */
  action: string;
  context?: { [key: string]: unknown };
  /** The surface's data model, when the surface was created asking for it. */
  dataModel?: { [key: string]: unknown };
  /**
   * The Card's data model as the kernel stores it: what the surface is made
   * of, rather than what the client sent back. A handler reads the state of
   * its own card here instead of keeping a second copy keyed by surface id.
   */
  record?: { [key: string]: unknown };
}

/** A card handler's refusal: the Card is left exactly as it was. */
export interface PluginCardDrop {
  drop: true;
  reason?: string;
}

/**
 * What a card handler answers with: the messages the kernel folds into the
 * Card, on their own or with `input` — one line for the Bot's next Turn, the
 * only thing a press may say to the Bot rather than to the card. `render`
 * never carries `input`; a draw is not a press.
 */
export type PluginCardAnswer =
  | CardMessage[]
  | { messages: CardMessage[]; input?: string }
  | PluginCardDrop
  | undefined
  | void;

/**
 * What a card's `render` answers with. The same messages a press answers
 * with, and beside them `covers`: the canonical values a decision on this
 * card would authorize. The Plugin states them because the Plugin, not the
 * model, decides what the card draws — a redraw that ignores the Bot's values
 * and shows the draft it is holding covers that draft. A draw that puts an
 * `ApprovalActions` on the card and declares no `covers`, or no `decision`,
 * is refused, so a decision bound to nothing — or asked in no words — cannot
 * exist.
 */
export type PluginCardDraw =
  | CardMessage[]
  | {
      messages: CardMessage[];
      covers?: { [key: string]: unknown };
      decision?: PluginCardDecision;
    }
  | PluginCardDrop
  | undefined
  | void;

/**
 * The words the decision a card asks for is recorded with. They are stated
 * here rather than on the `ApprovalActions` component because the Frock
 * catalog allows that component an `approvalId` and its two labels and
 * nothing else: the host draws the labels, the kernel records the Approval
 * with these, and a draw that asks for a decision and states none is refused.
 */
export interface PluginCardDecision {
  /** What the person is asked, in their words: "Send an email to …". */
  action: string;
  /** What getting it wrong costs. */
  risk: "low" | "medium" | "high";
  /** Why, when the action does not say. */
  rationale?: string;
}

/**
 * One Card the Plugin draws (ADR 0030). `render` composes the surface from
 * the catalogs the client compiled in; `actions` are the handlers behind the
 * names the surface's components raise. An action name is the Plugin's, not
 * one card's — the namespace is `plugin/<pluginId>/<action>` — so two cards
 * may not declare the same one.
 */
export interface PluginCard {
  render(
    payload: PluginCardRender,
    ctx: PluginContext,
  ): Promise<PluginCardDraw> | PluginCardDraw;
  actions?: Record<
    string,
    (
      press: PluginCardPress,
      ctx: PluginContext,
    ) => Promise<PluginCardAnswer> | PluginCardAnswer
  >;
}

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
  /**
   * One view per surface id declared under `views` in `plugin.json`: a
   * `settings.sections` block on this Plugin's card, a `conversation.panel`
   * page beside the conversation, or a `bot.nav` door. A panel view that
   * names a `page` returns that page's state instead of a tree.
   */
  views?: Record<string, PluginView>;
  /**
   * One entry per card id declared under `cards` in `plugin.json`. The Bot
   * calls the card's tool with the values, the kernel validates them against
   * the card's `dataSchema` and `render` answers with the surface.
   */
  cards?: Record<string, PluginCard>;
  /**
   * One entry per model provider declared under `modelProviders` in
   * `plugin.json` (ADR 0032). A Bot that selects that provider runs this
   * contribution; the host serves the credential through `ctx.modelTransport`.
   */
  modelProviders?: PluginModelProviders;
}
