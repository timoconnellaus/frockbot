import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { Store } from "@tanstack/store";
import {
  agentKey,
  modelKey,
  promptKey,
  requestAction,
  sessionKey,
  toolCallAction,
  toolsKey,
} from "./keys";
import { validateArgs } from "./tools";
import type {
  Agent,
  AgentStatus,
  AnyTool,
  CloseReason,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SessionEntry,
  SessionEntryInput,
  ToolCall,
  ToolOutcome,
} from "./types";

/** Read a message out of anything thrown, without leaning on `instanceof`. */
const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/**
 * What one turn runs against: taken once when the turn opens and held for every
 * step of it, so a turn sees one world (C3, C4, E2).
 */
interface TurnWorld {
  provider: ModelProvider | undefined;
  tools: Array<AnyTool>;
  system: string;
}

/** Where to resume turn numbering when a session was replayed or forked. */
const highestTurn = (entries: ReadonlyArray<SessionEntry>): number =>
  entries.reduce((highest, entry) => Math.max(highest, entry.turn), 0);

/**
 * Resolve with the work, or with `undefined` as soon as the signal aborts, so a
 * tool that ignores its signal cannot hold a cancellation open (C5).
 */
const raceAbort = <TValue>(
  work: Promise<TValue>,
  signal: AbortSignal,
): Promise<TValue | undefined> =>
  new Promise<TValue | undefined>((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      },
    );
  });

const loopOptions = optionsSchema<
  { maxSteps?: number; modelOptions?: Record<string, unknown> } | undefined,
  { maxSteps: number; modelOptions: Record<string, unknown> }
>((value) => ({
  maxSteps: value?.maxSteps ?? 16,
  modelOptions: { ...value?.modelOptions },
}));

/**
 * The loop: it takes up input, requests the model, runs the tools the model
 * called, and repeats until nothing is owed. Provides {@link agentKey} and owns
 * {@link requestAction} and {@link toolCallAction}, which are the seams every
 * other plugin intercepts it through (D1, D2).
 *
 * A turn sees one world: when it opens, the loop takes the current model
 * provider, the registered tools and the assembled prompt once, and every step
 * of that turn runs against them. A provider, tool or section added or removed
 * while a turn is running is picked up by the next turn (C3, C4, E2).
 *
 * @example
 * ```ts
 * const agent = client.getContext(agentKey)!
 * agent.send('hello')
 * await agent.idle()
 * ```
 */
export const loopPlugin = createPlugin({
  name: "loop",
  deps: [sessionKey, toolsKey, promptKey, modelKey],
  provides: [agentKey, requestAction, toolCallAction],
  validator: loopOptions,
  setup(instance, options) {
    const session = instance.context.get(sessionKey);
    const tools = instance.context.get(toolsKey);
    const prompt = instance.context.get(promptKey);
    const models = instance.context.get(modelKey);
    const status = new Store<AgentStatus>("idle");
    const queued: Array<string> = [];
    const idleWaiters: Array<() => void> = [];
    const detached = new AbortController();

    let turn = highestTurn(session.snapshot());
    /** How many **human steps** this instance has issued; their call ids. */
    let humanCalls = 0;
    /** The open turn's world, or `undefined` between turns. */
    let world: TurnWorld | undefined;
    let controller: AbortController | undefined;
    let running: Promise<void> | undefined;
    /** No new turns; the open one is being cancelled. */
    let closing = false;
    /** Removal is complete; nothing may write to the session any more (C6). */
    let stopped = false;
    /** Read through calls, so narrowing does not outlive an `await`. */
    const isClosing = (): boolean => closing;

    const signal = () => controller?.signal ?? detached.signal;
    const append = (entry: SessionEntryInput) => {
      if (!stopped) session.append(entry);
    };

    // ------------------------------------------------------------- the actions

    instance.defineAction(
      requestAction,
      async (request: ModelRequest): Promise<ModelResponse> => {
        const aborted = signal();
        const provider = world?.provider;
        if (!provider) {
          return {
            text: "",
            toolCalls: [],
            error: "no model provider is registered",
          };
        }
        // The turn holds its provider, but a provider unregistered underneath it
        // cannot be asked for another step (E2).
        if (!models.list().includes(provider)) {
          return {
            text: "",
            toolCalls: [],
            error: `the model provider "${provider.name}" was unregistered while the turn was running`,
          };
        }
        let text = "";
        const toolCalls: Array<ToolCall> = [];
        try {
          for await (const chunk of provider.stream(request, aborted)) {
            if (aborted.aborted) break;
            if (chunk.kind === "text") {
              text += chunk.text;
              append({
                kind: "chunk",
                turn: request.turn,
                step: request.step,
                text: chunk.text,
              });
            } else {
              toolCalls.push(chunk.call);
            }
          }
        } catch (error) {
          return { text, toolCalls, error: messageOf(error) };
        }
        return { text, toolCalls };
      },
    );

    instance.defineAction(
      toolCallAction,
      async ({ call, origin }): Promise<ToolOutcome> => {
        // A **human step** runs outside the turn, so it runs against the tools
        // registered right now; the turn's world is the model's, and C4 is
        // about what the model was offered when its turn opened.
        const human = origin === "human";
        const tool = human
          ? tools.get(call.name)
          : world?.tools.find((each) => each.name === call.name);
        if (!tool) return { ok: false, error: `unknown tool "${call.name}"` };
        // Offered for the whole turn, but refused once it is gone (C4).
        if (!tools.list().includes(tool)) {
          return {
            ok: false,
            error: `tool "${call.name}" was unregistered while the turn was running`,
          };
        }
        const validated = await validateArgs(tool, call.args);
        if (!validated.ok) return validated;
        try {
          const value: unknown = await tool.execute(validated.value, {
            call,
            // A person's call is not the turn's, so cancelling the turn does
            // not cancel it; it lives as long as the loop instance does.
            signal: human ? detached.signal : signal(),
          });
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
      },
    );

    // ---------------------------------------------------------------- the loop

    const buildRequest = (turnNumber: number, step: number): ModelRequest => ({
      turn: turnNumber,
      step,
      system: world?.system ?? "",
      messages: session.messages(),
      tools: (world?.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      options: { ...options.modelOptions },
    });

    const drain = (turnNumber: number): number => {
      let taken = 0;
      while (queued.length > 0) {
        append({ kind: "input", turn: turnNumber, text: queued.shift()! });
        taken += 1;
      }
      return taken;
    };

    const dispatchCall = async (
      call: ToolCall,
      turnNumber: number,
      step: number,
    ): Promise<ToolOutcome> => {
      try {
        return await instance.dispatch(toolCallAction, {
          call,
          turn: turnNumber,
          step,
        });
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    };

    /**
     * Run the calls of one step in concurrency batches: consecutive `parallel`
     * tools share a batch, anything exclusive or unknown runs alone, and results
     * are appended in the order the model issued the calls (D4).
     */
    const runCalls = async (
      turnNumber: number,
      step: number,
      calls: ReadonlyArray<ToolCall>,
      aborted: AbortSignal,
    ): Promise<boolean> => {
      const batches: Array<Array<ToolCall>> = [];
      let open: Array<ToolCall> | undefined;
      for (const call of calls) {
        const tool = world?.tools.find((each) => each.name === call.name);
        if (tool?.concurrency === "parallel") {
          if (!open) {
            open = [];
            batches.push(open);
          }
          open.push(call);
        } else {
          batches.push([call]);
          open = undefined;
        }
      }

      for (const batch of batches) {
        if (aborted.aborted) return false;
        for (const call of batch) {
          append({ kind: "tool-call", turn: turnNumber, step, call });
        }
        const outcomes = await raceAbort(
          Promise.all(
            batch.map((call) => dispatchCall(call, turnNumber, step)),
          ),
          aborted,
        );
        if (outcomes === undefined) return false;
        batch.forEach((call, index) => {
          append({
            kind: "tool-result",
            turn: turnNumber,
            step,
            callId: call.id,
            name: call.name,
            outcome: outcomes[index]!,
          });
        });
      }
      return true;
    };

    const runTurn = async (): Promise<void> => {
      turn += 1;
      const current = turn;
      const abort = new AbortController();
      // Read through a call: `aborted` is readonly, so TypeScript would narrow
      // it to `false` for the rest of the turn after the first check.
      const cancelled = (): boolean => abort.signal.aborted;
      controller = abort;
      // One world for the whole turn (C3).
      world = {
        provider: models.current(),
        tools: tools.list(),
        system: prompt.assemble(),
      };

      append({ kind: "turn-opened", turn: current });
      drain(current);

      let step = 0;
      let reason: CloseReason = "complete";
      try {
        for (;;) {
          if (cancelled()) {
            reason = "cancelled";
            break;
          }
          step += 1;
          if (step > options.maxSteps) {
            append({
              kind: "error",
              turn: current,
              scope: "loop",
              message: `the turn reached its step limit of ${options.maxSteps}`,
            });
            reason = "error";
            break;
          }

          append({ kind: "step-opened", turn: current, step });
          let response: ModelResponse;
          try {
            response = await instance.dispatch(
              requestAction,
              buildRequest(current, step),
            );
          } catch (error) {
            response = { text: "", toolCalls: [], error: messageOf(error) };
          }
          append({
            kind: "assistant",
            turn: current,
            step,
            text: response.text,
            toolCalls: response.toolCalls,
          });

          if (cancelled()) {
            append({
              kind: "step-closed",
              turn: current,
              step,
              reason: "cancelled",
            });
            reason = "cancelled";
            break;
          }
          if (response.error !== undefined) {
            append({
              kind: "error",
              turn: current,
              step,
              scope: "model",
              message: response.error,
            });
            append({
              kind: "step-closed",
              turn: current,
              step,
              reason: "error",
            });
            reason = "error";
            break;
          }

          const finished = await runCalls(
            current,
            step,
            response.toolCalls,
            abort.signal,
          );
          if (!finished) {
            append({
              kind: "step-closed",
              turn: current,
              step,
              reason: "cancelled",
            });
            reason = "cancelled";
            break;
          }

          append({
            kind: "step-closed",
            turn: current,
            step,
            reason: "complete",
          });
          const taken = drain(current);
          if (response.toolCalls.length === 0 && taken === 0) break;
        }
      } catch (error) {
        append({
          kind: "error",
          turn: current,
          step,
          scope: "loop",
          message: messageOf(error),
        });
        reason = "error";
      } finally {
        append({ kind: "turn-closed", turn: current, reason });
        controller = undefined;
        world = undefined;
      }
    };

    const start = () => {
      if (running || isClosing()) return;
      status.setState(() => "running");
      running = (async () => {
        try {
          while (!isClosing() && queued.length > 0) await runTurn();
        } finally {
          running = undefined;
          status.setState(() => "idle");
          for (const resolve of idleWaiters.splice(0)) resolve();
        }
      })();
    };

    const agent: Agent = {
      status,
      send: (text: string) => {
        queued.push(text);
        start();
      },
      cancel: async () => {
        queued.length = 0;
        controller?.abort(new Error("the turn was cancelled"));
        await running;
      },
      invoke: async (name: string, args?: unknown): Promise<ToolOutcome> => {
        if (stopped) {
          return { ok: false, error: "the agent has been removed" };
        }
        humanCalls += 1;
        const call: ToolCall = { id: `h${humanCalls}`, name, args };
        // The turn a person's call belongs beside: the one that is open, or the
        // last one that closed. `0` before the agent has ever run.
        const beside = turn;
        append({ kind: "human-tool-call", turn: beside, call });
        let outcome: ToolOutcome;
        try {
          outcome = await instance.dispatch(toolCallAction, {
            call,
            turn: beside,
            step: 0,
            origin: "human",
          });
        } catch (error) {
          outcome = { ok: false, error: messageOf(error) };
        }
        append({
          kind: "human-tool-result",
          turn: beside,
          callId: call.id,
          name,
          outcome,
        });
        return outcome;
      },
      idle: () =>
        status.state === "idle"
          ? Promise.resolve()
          : new Promise<void>((resolve) => idleWaiters.push(resolve)),
    };

    instance.provide(agentKey, agent);
    instance.cleanup(async () => {
      closing = true;
      await agent.cancel();
      stopped = true;
    }, "cancel the open turn");
  },
});
