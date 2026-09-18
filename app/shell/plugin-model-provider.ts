// The host's adapter from a Plugin's model provider contribution to the
// kernel's `LlmProvider` seam (ADR 0032).
//
// The loop reaches this exactly as it reaches a Package's provider: one
// normalized request in, normalized events out, with the durable intent, the
// idempotency key, the retry policy and the settlement all still the kernel's
// (it named the request id before this was called, and it settles the outcome
// after). What is new is where the answer comes from: one call into the
// Plugin worker, one credentialed transport call back out of it, and events
// decoded strictly on the way in.
//
// The adapter is deliberately suspicious of the Plugin. The request it serves
// must be the one its binding admitted — same provider, model, Connection and
// generation — and any replay state from another scope is dropped rather than
// handed over. The stream must carry exactly one terminal event, tool calls
// are held until it arrives, and nothing may follow it. A failure the Plugin
// states in its own words is believed about *why*; whether it may be retried
// or settled without a usage record is the host's answer, taken from what the
// host itself saw of the one upstream call. The dispatch is opened before the
// worker is called and ended when the attempt is over, so the one call this
// attempt is worth is also the only one it can make, and ending the attempt
// aborts an upstream call still in flight.
import {
  ModelOutcomeUncertainErrorV1,
  ModelProviderFailureError,
  type LlmProvider,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type PluginModelFailureEventV1,
  type PluginModelInvocationV1,
  type PluginWorkerModelResultV1,
  type ToolCall,
} from "@frockbot/core/contracts";
import { decodePluginModelEventLineV1 } from "@frockbot/core/contracts";
import {
  structuredOutputPlanV1,
  systemWithInstructionV1,
} from "@frockbot/providers/openai-compatible";
import {
  MODEL_FIRST_BYTE_DEADLINE_MS_V1,
  MODEL_IDLE_DEADLINE_MS_V1,
  MODEL_OUTCOME_UNCERTAIN_REASON_V1,
  ModelRequestDeadlineError,
  MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1,
} from "@frockbot/core/contracts";
import type {
  ModelDispatchHandleV1,
  PluginModelDispatchScopeV1,
} from "@frockbot/app/isolates/model-dispatch";

/**
 * The largest NDJSON line this adapter will hold. A model event is bounded at
 * its own seam; this bound is for the bytes between them, so a Plugin that
 * never sends a newline cannot grow the host's memory.
 */
export const PLUGIN_MODEL_EVENT_LINE_MAX_BYTES_V1 = 4 * 1024 * 1024;

/**
 * The whole answer, as the host will hold it.
 *
 * The Plugin's own parser bounds what *it* reads upstream, but a Plugin worker
 * is one realm shared with every other Plugin its User installed, and the host
 * is the one buffering. The ceiling is deliberately far below what the isolate
 * could allocate: the bytes arrive as chunks, are decoded to strings,
 * accumulated into events and retained by the session, so a stream that
 * overruns any of these bounds is refused before the copies multiply. Eight
 * mebibytes is already orders of magnitude past the largest answer the
 * deployment's own output bound permits, so no real reply comes near it.
 */
export const PLUGIN_MODEL_STREAM_MAX_BYTES_V1 = 8 * 1024 * 1024;
export const PLUGIN_MODEL_STREAM_MAX_EVENTS_V1 = 100_000;
export const PLUGIN_MODEL_STREAM_MAX_TOOL_CALLS_V1 = 128;

/** The binding one mounted provider was admitted with. */
export interface PluginModelProviderBindingV1 {
  provider: string;
  model: string;
  connectionId: string;
  connectionGeneration: string;
}

export interface PluginModelProviderOptionsV1 {
  pluginId: string;
  /**
   * The model protocol's two allowances. Defaults are the protocol's own —
   * two minutes to the first event, one minute between events — and a test
   * that drives the clock passes smaller ones rather than waiting.
   */
  deadlines?: { firstByteMs: number; idleMs: number };
  /** What one answer may cost the host to hold; defaults are the constants. */
  bounds?: { bytes: number; events: number; toolCalls: number };
  binding: PluginModelProviderBindingV1;
  /** One call into the mounted worker; refusals and errors already bounded. */
  streamModel(
    invocation: PluginModelInvocationV1,
  ): Promise<PluginWorkerModelResultV1>;
  /** Opens this attempt's dispatch; ending it aborts what the ticket started. */
  begin(input: {
    scope: PluginModelDispatchScopeV1;
    deadlineAt: number;
  }): ModelDispatchHandleV1;
  /**
   * Whether the Turn's own log shows an earlier dispatch of this effect that
   * nothing accounted for. The host answers it from its journal
   * (`priorOutcomeUnknownV1`), and it is asked before the worker is called so
   * that a request this mount cannot serve — the model changed while the run
   * was interrupted — does not report a definitive no-effect result for an
   * effect whose earlier call may have been accepted and billed.
   */
  priorOutcomeUnknownFor(requestId: string): boolean;
  /** The Turn this plugin serves; the request id is the attempt's own. */
  scope: Omit<PluginModelDispatchScopeV1, "requestId">;
}

/**
 * The request the Plugin is shown.
 *
 * The Connection binding is removed — the Plugin names no Connection, and the
 * host holds the authority its transport ticket resolves — and so is any
 * replay state whose provider, model, Connection or generation is not the one
 * this call was admitted under. A Turn that ran on another Connection, or
 * another model, must not hand its opaque provider content to this one.
 */
function pluginRequestV1(
  request: NormalizedModelRequest,
  binding: PluginModelProviderBindingV1,
): NormalizedModelRequest {
  const stripped: NormalizedModelRequest = {
    ...structuredClone(request),
    messages: request.messages.map((message) => {
      if (message.role !== "assistant") return structuredClone(message);
      const state = message.providerState;
      const inScope =
        state !== undefined &&
        state.provider === binding.provider &&
        state.model === binding.model &&
        state.connectionId === binding.connectionId &&
        state.connectionGeneration === binding.connectionGeneration;
      const { providerState: _dropped, ...rest } = message;
      return structuredClone(inScope ? message : rest);
    }),
  };
  delete stripped.modelBinding;
  return stripped;
}

/** One item off the Plugin's stream: an event for the kernel, or a heartbeat. */
type PluginStreamItemV1 =
  { kind: "event"; event: LlmStreamEvent } | { kind: "progress" };

/**
 * One NDJSON line stream, decoded and held to the protocol: exactly one
 * terminal event, tool calls only behind it, and nothing after it. A
 * heartbeat is passed through as one — the kernel never sees it, and the
 * clock is what it is for.
 */
async function* pluginEventsV1(
  lines: AsyncIterable<string>,
  request: NormalizedModelRequest,
  pluginId: string,
  bounds: { events: number; toolCalls: number },
): AsyncIterable<PluginStreamItemV1> {
  let terminal = false;
  let events = 0;
  const held: ToolCall[] = [];
  for await (const line of lines) {
    if (terminal) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "the plugin's model stream carried events after its terminal",
      });
    }
    events += 1;
    if (events > bounds.events) {
      throw new ModelProviderFailureError({
        classification: "unknown",
        reason: `plugin "${pluginId}" sent more model events than this deployment accepts`,
      });
    }
    const event = decodePluginModelEventLineV1(line);
    if (event.type === "progress") {
      yield { kind: "progress" };
      continue;
    }
    if (event.type === "provider-failure") {
      throw pluginFailureV1(event);
    }
    if (event.type === "finish") {
      terminal = true;
      // The provider's own tool calls are released only now: a stream that
      // died before its terminal left a call the kernel never saw, which is
      // exactly what the Turn's outcome should say.
      for (const call of held)
        yield { kind: "event", event: { type: "tool-call", call } };
      held.length = 0;
      yield { kind: "event", event };
      continue;
    }
    if (event.type === "tool-call") {
      held.push(event.call);
      if (held.length > bounds.toolCalls) {
        throw new ModelProviderFailureError({
          classification: "unknown",
          reason: `plugin "${pluginId}" held more tool calls than this deployment accepts`,
        });
      }
      continue;
    }
    if (event.type === "provider-state") {
      // The identity on a replay state is the host's to state, exactly as it
      // is for a Package: the Plugin holds the opaque provider content and
      // never the Connection, so the binding the kernel checks is filled in
      // from what the kernel already resolved.
      yield {
        kind: "event",
        event: {
          type: "provider-state",
          state: {
            ...event.state,
            provider: request.provider,
            model: request.model,
            connectionId: request.modelBinding!.connectionId,
            ...(request.modelBinding!.connectionGeneration === undefined
              ? {}
              : {
                  connectionGeneration:
                    request.modelBinding!.connectionGeneration,
                }),
          },
        },
      };
      continue;
    }
    yield { kind: "event", event };
  }
  if (!terminal) {
    throw new ModelProviderFailureError({
      classification: "unknown",
      reason: "the plugin's model stream ended without a terminal event",
    });
  }
}

/** The failure a Plugin stated, with the reason bounded and nothing else trusted. */
function pluginFailureV1(event: PluginModelFailureEventV1): Error {
  return new ClassificationCarrierV1(
    event.classification,
    event.reason.slice(0, MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1),
    event.retryAfterMs,
  );
}

/**
 * A failure the Plugin stated, carried to the one place that decides what it
 * is allowed to mean: the adapter, which knows whether the host itself made
 * the call and what the provider answered.
 */
class ClassificationCarrierV1 extends Error {
  readonly name = "PluginModelFailure";
  constructor(
    readonly claimed: PluginModelFailureEventV1["classification"],
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * One attempt's clock: the first-byte allowance before anything arrives, the
 * silence allowance between events afterwards, and the caller's own signal
 * folded in. Every event resets it, heartbeats included — a reasoning model
 * that is thinking, or a tool call whose arguments are still arriving, is a
 * provider that is working, and the answer must not be cut off for it.
 */
class AttemptClockV1 {
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #phase: "first-byte" | "idle" = "first-byte";
  #expired: ModelRequestDeadlineError | undefined;
  readonly #signal: AbortSignal;
  readonly #onCallerAbort = () => {
    this.#controller.abort(this.#signal.reason);
  };
  #disposed = false;

  constructor(
    private readonly deadlines: { firstByteMs: number; idleMs: number },
    signal: AbortSignal,
  ) {
    this.#signal = signal;
    if (signal.aborted) this.#onCallerAbort();
    else signal.addEventListener("abort", this.#onCallerAbort, { once: true });
    this.#arm();
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The deadline this attempt ran out of, when that is why it ended. */
  get expired(): ModelRequestDeadlineError | undefined {
    return this.#expired;
  }

  #arm(): void {
    if (this.#disposed || this.#controller.signal.aborted) return;
    const allowance =
      this.#phase === "first-byte"
        ? this.deadlines.firstByteMs
        : this.deadlines.idleMs;
    this.#timer = setTimeout(() => {
      this.#expired = new ModelRequestDeadlineError(this.#phase, allowance);
      this.#controller.abort(this.#expired);
    }, allowance);
  }

  /** One event, or one heartbeat, arrived: the allowance starts again. */
  progressed(): void {
    if (this.#disposed) return;
    this.#phase = "idle";
    clearTimeout(this.#timer);
    this.#arm();
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#signal.removeEventListener("abort", this.#onCallerAbort);
  }
}

/**
 * The worker's answer, opened within the attempt's clock. A worker RPC that
 * hangs before answering is the clock's to end like anything else: the
 * dispatch is already being finished, so what is left is to stop waiting.
 */
async function openedWithinClockV1(
  opening: Promise<PluginWorkerModelResultV1>,
  clock: AttemptClockV1,
): Promise<PluginWorkerModelResultV1> {
  if (clock.signal.aborted) throw clockAbortV1(clock);
  return await new Promise<PluginWorkerModelResultV1>((resolve, reject) => {
    const onAbort = () => reject(clockAbortV1(clock));
    clock.signal.addEventListener("abort", onAbort, { once: true });
    opening
      .then(
        (result) => {
          // An answer that arrives after the attempt is over is an answer to
          // nobody. It is still a live stream the Plugin is producing from a
          // body it is holding open, so it is cancelled here — the same
          // release the reader's own cancel does for an answer that arrived in
          // time.
          if (clock.signal.aborted) {
            void cancelResultStreamV1(result);
            return;
          }
          resolve(result);
        },
        (error) => {
          if (!clock.signal.aborted) reject(error);
        },
      )
      .finally(() => clock.signal.removeEventListener("abort", onAbort));
  });
}

/** Releases a worker answer nobody is going to read. Never throws. */
async function cancelResultStreamV1(
  result: PluginWorkerModelResultV1,
): Promise<void> {
  if (result.status !== "streaming") return;
  try {
    await result.events.cancel();
  } catch {
    // A stream already closed by its producer has nothing to cancel.
  }
}

/** Why an attempt stopped waiting: its own deadline, or the caller's abort. */
function clockAbortV1(clock: AttemptClockV1): Error {
  return (
    clock.expired ??
    new Error("the model call was stopped before its answer arrived")
  );
}

/** The caller's own reason for a stop, as the text a failure carries. */
function stoppedBeforeStartV1(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : "the model call was stopped before it began";
}

/** The Plugin's events, with heartbeats folded into the clock. */
async function* clockedEventsV1(
  events: AsyncIterable<PluginStreamItemV1>,
  clock: AttemptClockV1,
): AsyncIterable<LlmStreamEvent> {
  for await (const item of events) {
    clock.progressed();
    if (item.kind === "event") yield item.event;
  }
  // A stream that ended because the clock fired must say so rather than
  // looking like an answer that stopped early.
  if (clock.signal.aborted && clock.expired) throw clock.expired;
}

/**
 * The lines of one worker answer, decoded from its NDJSON byte stream.
 *
 * The deadline signal is the caller's own — a Stop, the first-byte or idle
 * allowance — and it cancels the worker's stream, which is what returns the
 * Plugin's generator and lets it release the upstream body it is reading.
 */
async function* modelResultLinesV1(
  result: PluginWorkerModelResultV1,
  pluginId: string,
  deadline: AbortSignal,
  maxBytes: number,
): AsyncIterable<string> {
  if (result.status === "refused") {
    throw new ModelProviderFailureError({
      classification: "permanent",
      reason: result.reason,
    });
  }
  const reader = result.events.getReader();
  // Why the attempt stopped, when it was the clock or the caller rather than
  // the Plugin: a cancelled read looks exactly like a stream that ended, and
  // the two mean opposite things.
  let aborted: Error | undefined;
  const onAbort = () => {
    aborted =
      deadline.reason instanceof Error
        ? deadline.reason
        : new Error("the model call was stopped before its answer arrived");
    void reader.cancel(aborted).catch(() => undefined);
  };
  if (deadline.aborted) onAbort();
  else deadline.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  try {
    for (;;) {
      if (aborted !== undefined) throw aborted;
      const chunk = await reader.read();
      if (aborted !== undefined) throw aborted;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new ModelProviderFailureError({
          classification: "unknown",
          reason: `plugin "${pluginId}" sent more model bytes than this deployment accepts`,
        });
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > PLUGIN_MODEL_EVENT_LINE_MAX_BYTES_V1) {
        throw new ModelProviderFailureError({
          classification: "unknown",
          reason: `plugin "${pluginId}" sent a model event larger than this deployment accepts`,
        });
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield line;
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) yield tail;
  } catch (error) {
    if (aborted !== undefined) throw aborted;
    // The worker's own failure text is untrusted prose from the Plugin, so it
    // is bounded and classified rather than passed through as the reason.
    throw new ModelProviderFailureError({
      classification: "unknown",
      reason:
        error instanceof Error && error.message
          ? `${pluginId}: ${error.message}`
          : `plugin "${pluginId}" ended its model stream`,
    });
  } finally {
    deadline.removeEventListener("abort", onAbort);
    // The worker stream is cancelled on every exit, including an early return
    // from the consumer: the Plugin's generator is returned, which is what
    // releases the upstream body it was reading.
    try {
      await reader.cancel();
    } catch {
      // A stream already closed by its producer has nothing to cancel.
    }
  }
}

/**
 * One Plugin's model provider, as the kernel's `LlmProvider`.
 *
 * `supports` is `none`: this protocol has no native structured-output mode,
 * so the kernel's shared validator stays authoritative and the request is
 * shaped with the same prompt guidance a Package with no JSON mode gets.
 */
export function pluginModelProviderV1(
  options: PluginModelProviderOptionsV1,
): LlmProvider {
  return {
    id: options.binding.provider,
    supports: { structuredOutput: "none" },
    async *stream(
      request: NormalizedModelRequest,
      signal: AbortSignal,
    ): AsyncIterable<LlmStreamEvent> {
      // A caller that had already stopped is answered before anything opens:
      // no dispatch to end, no worker call to orphan. Checked here because the
      // worker call below is *created* before the clock can look at it, and a
      // promise nobody awaits is a stream the Plugin keeps producing.
      //
      // What it is worth is the question the request refusal below answers:
      // nothing was sent, so this attempt is a call that did not happen — a
      // definitive result the kernel settles without an estimate, never the
      // ordinary error it would write one for. The exception is an effect the
      // log shows was dispatched once already and never accounted for: its
      // earlier call may have billed, and the one estimate that stands for it
      // is what this outcome preserves.
      if (signal.aborted) {
        if (options.priorOutcomeUnknownFor(request.requestId)) {
          throw new ModelOutcomeUncertainErrorV1();
        }
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: stoppedBeforeStartV1(signal),
        });
      }
      // The Plugin serves one provider, one model and one Connection, and all
      // three were resolved by the kernel before this provider was mounted. A
      // request that names anything else is authority this adapter does not
      // hold, and it is refused before the worker or the network is reached.
      const binding = request.modelBinding;
      if (
        request.provider !== options.binding.provider ||
        request.model !== options.binding.model ||
        !binding?.connectionId ||
        !binding.connectionGeneration ||
        binding.connectionId !== options.binding.connectionId ||
        binding.connectionGeneration !== options.binding.connectionGeneration
      ) {
        // A refusal this early is still a result for the effect, not for this
        // attempt: if the log shows the effect was dispatched before and never
        // accounted for — a request re-dispatched after an interruption whose
        // model has since changed — the earlier call may have billed, and this
        // is the uncertain outcome that keeps its possible cost.
        if (options.priorOutcomeUnknownFor(request.requestId)) {
          throw new ModelOutcomeUncertainErrorV1();
        }
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: "Model Connection authority is invalid",
        });
      }
      const plan = structuredOutputPlanV1(request, "none");
      if (plan.note) yield { type: "response-format-note", note: plan.note };
      const pluginRequest = pluginRequestV1(request, options.binding);
      pluginRequest.system =
        systemWithInstructionV1(request.system, plan.instruction) ?? "";
      const deadlines = options.deadlines ?? {
        firstByteMs: MODEL_FIRST_BYTE_DEADLINE_MS_V1,
        idleMs: MODEL_IDLE_DEADLINE_MS_V1,
      };
      const bounds = options.bounds ?? {
        bytes: PLUGIN_MODEL_STREAM_MAX_BYTES_V1,
        events: PLUGIN_MODEL_STREAM_MAX_EVENTS_V1,
        toolCalls: PLUGIN_MODEL_STREAM_MAX_TOOL_CALLS_V1,
      };
      const dispatch = options.begin({
        scope: { ...options.scope, requestId: request.requestId },
        // The upstream call must answer with headers inside the first-byte
        // allowance; what follows is bounded by the silence rule.
        deadlineAt: Date.now() + deadlines.firstByteMs,
      });
      const invocation: PluginModelInvocationV1 = {
        schemaVersion: 1,
        pluginId: options.pluginId,
        provider: options.binding.provider,
        protocolVersion: 1,
        request: pluginRequest,
        transportId: dispatch.transportId,
        botId: options.scope.botId,
        sessionId: options.scope.sessionId,
        runId: options.scope.runId,
        turnId: options.scope.turnId,
        generationId: options.scope.generationId,
        deadlineMs: deadlines.idleMs,
        firstEventDeadlineMs: deadlines.firstByteMs,
      };
      // The attempt owns its clock and its abort. Both the caller's signal —
      // a Stop, the Turn deadline — and either allowance end the attempt by
      // *finishing the dispatch first*, which aborts an upstream call still
      // in flight: that abort is what settles a Plugin parked inside its
      // transport call, and it must not wait on a stream cancellation that is
      // itself waiting on the generator to return.
      const clock = new AttemptClockV1(deadlines, signal);
      clock.signal.addEventListener("abort", () => dispatch.finish(), {
        once: true,
      });
      try {
        const result = await openedWithinClockV1(
          options.streamModel(invocation),
          clock,
        );
        yield* clockedEventsV1(
          pluginEventsV1(
            modelResultLinesV1(
              result,
              options.pluginId,
              clock.signal,
              bounds.bytes,
            ),
            request,
            options.pluginId,
            bounds,
          ),
          clock,
        );
      } catch (error) {
        throw classifyFailureV1(error, dispatch);
      } finally {
        clock.dispose();
        dispatch.finish();
      }
    },
  };
}

/**
 * What a failure is allowed to mean, decided by the host rather than claimed
 * by the Plugin.
 *
 * The host's own record is what decides, and the effect's own history comes
 * before this attempt's: an effect whose earlier dispatch the log never
 * accounted for is uncertain whatever happens here, because what is unknown is
 * the earlier call and only the estimate can stand for it — a refusal this
 * attempt never sent is not a result that can erase that cost. Past that, a
 * refusal the host made or read before the provider did any work is a
 * definitive no-effect result. A deadline is the host waiting on a call the
 * Plugin may have made: it stays uncertain when a call did leave, and is
 * otherwise the failure the deadline's own sentence describes, because a
 * worker that never reached the transport dispatched nothing to bill. A
 * failure with nothing sent at all is otherwise the Plugin's to explain, and
 * the host believes it about why because it has no answer of its own.
 * Anything else means the call went out and nothing definitive came back,
 * which is an uncertain outcome the kernel settles rather than retries; a
 * `ModelProviderFailureError` would tell the kernel and Billing that nothing
 * had happened.
 */
function classifyFailureV1(
  error: unknown,
  dispatch: ModelDispatchHandleV1,
): Error {
  const claimed = error instanceof ClassificationCarrierV1 ? error : undefined;
  const reason =
    error instanceof Error && error.message
      ? error.message
      : "the model provider did not complete this request";
  if (dispatch.priorOutcomeUnknown()) {
    // The effect this attempt answers for was dispatched once already and the
    // log never accounted for it. Whether the earlier call reached the
    // provider and billed is exactly what is unknown, and that outranks
    // whatever this attempt did: a refusal made before this fetch — or a
    // worker that never reached the transport — would otherwise report a
    // definitive no-effect result and erase the earlier call's possible cost.
    return uncertainOutcomeV1(reason);
  }
  const refusal = dispatch.refusal();
  if (refusal) {
    // The host itself saw the provider's answer, or made the decision not to
    // send: nothing was taken, and the classification is the host's.
    return new ModelProviderFailureError({
      classification: refusal.classification,
      reason,
      ...(refusal.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: refusal.retryAfterMs }),
    });
  }
  if (error instanceof ModelRequestDeadlineError) {
    // A clock ran out. Whether that is uncertainty depends on whether there is
    // anything to be uncertain about: a call the host sent may have been
    // accepted and billed, so it is settled with the estimate; an attempt with
    // nothing dispatched — and nothing before it that was unaccounted for,
    // which the check above would have caught — is a call that did not happen,
    // and the kernel's own sentence for the deadline is the answer, with no
    // estimate written for a call nobody made.
    return dispatch.sent()
      ? new ModelOutcomeUncertainErrorV1(error.message)
      : new ModelProviderFailureError({
          classification: "permanent",
          reason: error.message,
        });
  }
  if (!dispatch.sent()) {
    // Nothing left the host: there is nothing that could have billed, and the
    // Plugin's own words stand because the host has no reading of its own.
    return new ModelProviderFailureError({
      classification: claimed?.claimed ?? "unknown",
      reason,
      ...(claimed?.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: claimed.retryAfterMs }),
    });
  }
  // The call went out and nothing definitive came back. That is not a
  // classified provider failure — the kernel's own accounting treats one of
  // those as a call that never happened — and it is not retried: the kernel
  // settles it, records the estimate, and never dispatches this effect again.
  return uncertainOutcomeV1(reason);
}

/**
 * The uncertain outcome with the sentence a person reads first, and the host's
 * own account of what it saw after it.
 *
 * A failure's stored text is a diagnostic, and the projection hands a person
 * only a sentence it recognises (`runFailureCopyV1`). A Plugin's words about
 * why its answer died are prose this deployment did not write, and the
 * transport's account of a 5xx or of a refused replay is internals; neither
 * belongs in a bubble. So the product's own sentence for an outcome the person
 * can act on goes first — the call went out and its answer was lost — and the
 * diagnostic follows it, where the debug surface still reads exactly what the
 * host observed.
 */
function uncertainOutcomeV1(diagnostic: string): ModelOutcomeUncertainErrorV1 {
  const detail = diagnostic.trim();
  return new ModelOutcomeUncertainErrorV1(
    detail.length === 0 || detail === MODEL_OUTCOME_UNCERTAIN_REASON_V1
      ? MODEL_OUTCOME_UNCERTAIN_REASON_V1
      : `${MODEL_OUTCOME_UNCERTAIN_REASON_V1} The host recorded: ${detail}`,
  );
}
