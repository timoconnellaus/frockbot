// A runtime for a feature under test: the real registries, no loop.
import { ComputerRegistry } from "@frockbot/computer/core/host";
import {
  type AgentRuntimeV1,
  LoopHookListV1,
  mountRuntimeFeaturesV1,
  type RuntimeFeatureV1,
  SessionStore,
  type SessionStoreConfig,
  type ToolCall,
} from "@frockbot/core/contracts";
import type { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import { LlmRegistry } from "@frockbot/core/models";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";

/**
 * The session events a tool appends at a position in the conversation: a
 * bubble, an answer, a hand-off, a dispatch chip. A person reads them in the
 * order they landed, and the order they landed in is the order their durable
 * identities are minted in, so two of them dispatched at once in one `batch`
 * may not race. `orderedEffect` is what keeps them out of the race, and a tool
 * that appends one of these without declaring it is a defect no test of that
 * tool on its own can see.
 *
 * This is the one enumeration: a new conversation-positioned event type is an
 * edit here, and every harness in the repo starts checking it at once.
 */
export const CONVERSATION_POSITIONED_EVENTS_V1 = [
  "send/to-user",
  "reply/to-caller",
  "wake/parent",
  "task/dispatched",
] as const;

export interface AgentRuntimeHarness extends AgentRuntimeV1 {
  readonly systemPrompt: SystemPromptRegistry;
  readonly llm: LlmRegistry;
  readonly tools: ToolRegistry;
  readonly computers: ComputerRegistry;
  credentials?: CredentialLeaseRuntime;
  /** Mount one feature; what it registered is undone by `dispose`. */
  mount(feature: RuntimeFeatureV1<AgentRuntimeHarness>): Promise<void>;
  dispose(): Promise<void>;
}

export function createAgentRuntimeHarness(
  options: { sessions?: SessionStoreConfig } = {},
): AgentRuntimeHarness {
  const hooks = new LoopHookListV1();
  const systemPrompt = new SystemPromptRegistry(hooks);
  const cleanups: Array<() => Promise<void>> = [];
  const sessions = new SessionStore(options.sessions);
  const tools = new ToolRegistry(hooks, systemPrompt);
  // Every tool any test runs through this harness is watched: if its execution
  // put a conversation-positioned event on the log under its own effect id,
  // the tool has to have declared `orderedEffect`. The check is here rather
  // than in one feature's tests because it is the whole catalog's invariant,
  // and it is what the *next* such tool meets without anybody remembering to
  // write a test for it.
  const unordered = new Set<string>();
  // The call the model wrote, kept against the preparation it produced: a
  // dynamic tool's ordering is declared on the inner definition and read
  // through the meta-call, which is the call a dispatcher classifies.
  const declaredCalls = new WeakMap<object, ToolCall>();
  const prepare = tools.prepare.bind(tools);
  tools.prepare = async (call, context) => {
    const preparation = await prepare(call, context);
    declaredCalls.set(preparation, call);
    return preparation;
  };
  const dispatch = tools.executePrepared.bind(tools);
  tools.executePrepared = async (preparation, context) => {
    const before = sessions.get(context.sessionId)?.events.length ?? 0;
    const result = await dispatch(preparation, context);
    const call =
      declaredCalls.get(preparation) ?? context.toolCall ?? preparation.call;
    const landed = sessions
      .get(context.sessionId)
      ?.events.slice(before)
      .find(
        (event) =>
          (CONVERSATION_POSITIONED_EVENTS_V1 as readonly string[]).includes(
            event.type,
          ) &&
          (event as { occurrenceId?: string }).occurrenceId ===
            context.effectId,
      );
    if (landed && !tools.orderedEffect(call)) {
      unordered.add(`${preparation.call.name} appended ${landed.type}`);
    }
    return result;
  };
  const harness: AgentRuntimeHarness = {
    sessions,
    systemPrompt,
    llm: new LlmRegistry(hooks),
    tools,
    computers: new ComputerRegistry(),
    hooks,
    async mount(feature) {
      cleanups.push(await mountRuntimeFeaturesV1(harness, [feature]));
    },
    async dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      if (unordered.size > 0) {
        const observed = [...unordered].join("; ");
        unordered.clear();
        throw new Error(
          `${observed}. A tool whose effect takes a position in the conversation must declare orderedEffect, or a batch will let it race the others and the transcript, the wire ordinals and the notifications will disagree about what happened first.`,
        );
      }
    },
  };
  return harness;
}
