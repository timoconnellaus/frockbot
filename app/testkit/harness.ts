// A runtime for a feature under test: the real registries, no loop.
import { ComputerRegistry } from "@frockbot/computer/core/host";
import {
  type AgentRuntimeV1,
  LoopHookListV1,
  mountRuntimeFeaturesV1,
  type RuntimeFeatureV1,
  SessionStore,
  type SessionStoreConfig,
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

/**
 * What the journal says about ordering, read back after the fact: for every
 * conversation-positioned event, the `tool/call` that shares its occurrence
 * id names the tool that appended it, and that tool has to have declared
 * `orderedEffect`. Nothing is intercepted — this reads only what was
 * journalled, so it sees a sub-call of a `batch` exactly as it sees a
 * top-level call, and a run that journalled no calls says nothing.
 */
function undeclaredConversationAppends(
  sessions: SessionStore,
  tools: ToolRegistry,
): string[] {
  const observed = new Set<string>();
  for (const session of sessions.list()) {
    const calls = new Map<string, { name: string; input: unknown }>();
    for (const event of session.events) {
      if (event.type === "tool/call") {
        calls.set(event.occurrenceId, { name: event.name, input: event.input });
      }
    }
    for (const event of session.events) {
      if (
        !(CONVERSATION_POSITIONED_EVENTS_V1 as readonly string[]).includes(
          event.type,
        )
      ) {
        continue;
      }
      const occurrenceId = (event as { occurrenceId?: string }).occurrenceId;
      if (!occurrenceId) continue;
      const call = calls.get(occurrenceId);
      if (!call) continue;
      if (tools.orderedEffect({ id: occurrenceId, ...call })) continue;
      observed.add(`${call.name} appended ${event.type}`);
    }
  }
  return [...observed];
}

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
      const undeclared = undeclaredConversationAppends(sessions, tools);
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      if (undeclared.length > 0) {
        throw new Error(
          `${undeclared.join("; ")}. A tool whose effect takes a position in the conversation must declare orderedEffect, or a batch will let it race the others and the transcript, the wire ordinals and the notifications will disagree about what happened first.`,
        );
      }
    },
  };
  return harness;
}
