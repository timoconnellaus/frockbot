import {
  createAction,
  createContextKey,
  createEvent,
} from "@frockbot/compose-core";
import type {
  ActionDefinition,
  ContextKey,
  EventDefinition,
} from "@frockbot/compose-core";
import type {
  Agent,
  ModelRegistry,
  ModelRequest,
  ModelResponse,
  PromptRegistry,
  SessionEntry,
  SessionLog,
  ToolCallInput,
  ToolOutcome,
  ToolRegistry,
} from "./types";

/**
 * The **model** registry: the current **model provider**, which turns messages
 * and tool definitions into a streamed response. The key is stable — one plugin
 * provides it for the life of the client, and provider plugins register into it
 * and unregister through their cleanup (A2, E2).
 */
export const modelKey: ContextKey<ModelRegistry> =
  createContextKey<ModelRegistry>("agent.model");

/** The **tool** registry: what the model may call, and how a call is executed. */
export const toolsKey: ContextKey<ToolRegistry> =
  createContextKey<ToolRegistry>("agent.tools");

/** The **prompt section** registry, assembled in order for every step. */
export const promptKey: ContextKey<PromptRegistry> =
  createContextKey<PromptRegistry>("agent.prompt");

/** The **session**: the append-only log everything model-visible comes from. */
export const sessionKey: ContextKey<SessionLog> =
  createContextKey<SessionLog>("agent.session");

/** The **agent** handle: queue input, cancel a turn, watch the status. */
export const agentKey: ContextKey<Agent> = createContextKey<Agent>("agent");

/**
 * Emitted once for every entry appended to the session, so a UI or a
 * persistence plugin can follow a conversation without importing the loop (B4).
 * The payload is the entry itself, a discriminated union on `kind` (F2).
 */
export const sessionAppendedEvent: EventDefinition<SessionEntry, false> =
  createEvent<SessionEntry>("agent.session.appended");

/**
 * The **request**: one step's messages and tools going to the model. Middleware
 * may rewrite the system prompt, the messages, the tools or the options, or veto
 * the step by returning a response without calling `next` (D1).
 */
export const requestAction: ActionDefinition<ModelRequest, ModelResponse> =
  createAction<ModelRequest, ModelResponse>("agent.request");

/**
 * Executing one **tool** call. Middleware may rewrite `call.args`, replace the
 * outcome, or refuse the call with `{ ok: false, error }`, which the model sees
 * as a tool error (D2). Arguments are validated inside the handler, so rewritten
 * arguments are validated too (D3).
 */
export const toolCallAction: ActionDefinition<ToolCallInput, ToolOutcome> =
  createAction<ToolCallInput, ToolOutcome>("agent.toolCall");
