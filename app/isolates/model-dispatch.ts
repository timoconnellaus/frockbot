// The dispatches one Bot Durable Object is serving for its model provider
// Plugins (ADR 0032).
//
// A model dispatch is one attempt at one admitted model call. The host mints
// a ticket for it, the Plugin presents that ticket on its one upstream call,
// and the ticket is spent by the call it is spent on — which is what stops an
// admitted effect being fanned into several paid calls. The registry is
// memory, never storage: an eviction loses the attempt with it, and the loop
// re-dispatches under the same request id, where the Turn's own durable log
// decides whether the effect may be sent again.
//
// The dispatch also owns the upstream call's abort. `finish` — the attempt
// ending for any reason, including the stream being abandoned — aborts a call
// that is still running, which is the only thing that settles a Plugin hung
// waiting on it.
import type {
  ModelProviderFailureClassV1,
  Session,
} from "@frockbot/core/contracts";

/** The Turn-scope a model dispatch belongs to. */
export interface PluginModelDispatchScopeV1 {
  botId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  generationId: string;
  /**
   * The durable model effect this dispatch is: the loop's request id, which
   * the Turn's log carries as a `model/request` before anything is sent.
   */
  requestId: string;
}

/** What the host itself saw of the one upstream call, if it made one. */
export interface ModelDispatchRefusalV1 {
  /** The provider's own status, 0 when the call never reached it. */
  httpStatus: number;
  classification: ModelProviderFailureClassV1;
  retryAfterMs?: number;
}

/** One admitted model dispatch, as the host registered it. */
export interface ModelDispatchV1 {
  transportId: string;
  requestId: string;
  pluginId: string;
  provider: string;
  model: string;
  connectionId: string;
  connectionGeneration: string;
  /** The Package the Connection belongs to, as the admission resolved it. */
  packageId: string;
  /** The endpoint the deployment's catalog named, when the Connection names none. */
  endpoint: string;
  /** The one route a call for this provider may take. */
  route: string;
  /** The most output this deployment lets one call ask the provider for. */
  maxOutputTokens: number;
  scope: PluginModelDispatchScopeV1;
  /**
   * The session this call's durable record lives in, held by the host that
   * mounted the composition. It is never taken from the Plugin: the ticket
   * names a session the host itself is holding, which is what lets a call
   * that outlives its Turn — a summariser — still be checked against its own
   * log.
   */
  session: Session;
  /**
   * When the upstream call must have answered with headers, in epoch
   * milliseconds: the model protocol's first-byte allowance. The body that
   * follows is bounded by the silence rule, not by this.
   */
  deadlineAt: number;
  /** Set by the host when it made the call and the provider refused it. */
  refusal?: ModelDispatchRefusalV1;
  spent: boolean;
  abort: AbortController;
}

/** What one attempt holds: its ticket, and what the host learned from it. */
export interface ModelDispatchHandleV1 {
  transportId: string;
  /**
   * Retires the ticket and aborts the upstream call if it is still running.
   * Called however the attempt ends — its own error, the caller's signal, the
   * stream being abandoned — so nothing outlives the attempt it belongs to.
   */
  finish(): void;
  /** Whether the Plugin presented the ticket and the call was made. */
  spent(): boolean;
  /** What the host saw of that call, when the provider refused it. */
  refusal(): ModelDispatchRefusalV1 | undefined;
}

/**
 * The dispatches this object is currently serving, by ticket.
 *
 * `begin` mints a ticket; `take` spends it, exactly once; `finish` ends the
 * attempt and aborts whatever the ticket started. A ticket that is never
 * presented still ends with `finish`, so a Plugin cannot leave an abort
 * controller armed behind it.
 */
export class PluginModelDispatchRegistryV1 {
  readonly #dispatches = new Map<string, ModelDispatchV1>();

  begin(input: Omit<ModelDispatchV1, "transportId" | "spent" | "abort">): {
    handle: ModelDispatchHandleV1;
    dispatch: ModelDispatchV1;
  } {
    const transportId = crypto.randomUUID();
    const dispatch: ModelDispatchV1 = {
      ...input,
      transportId,
      spent: false,
      abort: new AbortController(),
    };
    this.#dispatches.set(transportId, dispatch);
    return {
      dispatch,
      handle: {
        transportId,
        finish: () => {
          this.#dispatches.delete(transportId);
          if (!dispatch.abort.signal.aborted) {
            dispatch.abort.abort(new Error("the model dispatch ended"));
          }
        },
        spent: () => dispatch.spent,
        refusal: () => dispatch.refusal,
      },
    };
  }

  /** Spends one ticket, exactly once. */
  take(transportId: string): ModelDispatchV1 | undefined {
    const dispatch = this.#dispatches.get(transportId);
    if (!dispatch) return undefined;
    this.#dispatches.delete(transportId);
    dispatch.spent = true;
    return dispatch;
  }

  get size(): number {
    return this.#dispatches.size;
  }
}
