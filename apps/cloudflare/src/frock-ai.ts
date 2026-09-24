import { MODEL_FIRST_BYTE_DEADLINE_MS_V1 } from "@frockbot/core/contracts";
import {
  FROCK_AI_DEFAULT_AUTO_ROUTE,
  gatewayModelForFrockIdV1,
} from "@frockbot/providers/frock-ai/catalog";
import {
  frockAiServedModelFromHeadersV1,
  FrockAiTransportErrorV1,
  type FrockAiChatCompletionV1,
} from "@frockbot/providers/frock-ai/runtime";

export const DEFAULT_FROCK_AI_GATEWAY_ID_V1 = "flock";

export interface FrockAiGatewayHostV1 {
  /** `null` when this host took the `AI` binding, which carries no dynamic route. */
  autoRoute: string | null;
  runChatCompletion: FrockAiChatCompletionV1;
}

/**
 * The Gateway request is bounded so a gateway that accepts the connection and
 * then never answers fails the Turn instead of holding it open. The deadline
 * covers *reaching* the gateway — nothing more. The SSE body that follows is
 * bounded by the kernel's own first-byte and idle deadlines, which is where the
 * copy a person reads lives.
 *
 * It was 60s, and it did not stop at the headers: the same signal was handed to
 * `fetch` and left armed, so it guillotined the response body sixty seconds
 * into a tool-calling step. The body's abort surfaced as a raw
 * `TimeoutError: The operation was aborted due to timeout`, which the Agent
 * read as an *uncertain* model outcome and parked the run on — a `POST /turns`
 * answering 500 after 65s with "Couldn't reach the Bot" on screen. A step that
 * carries a large SKILL.md plus the dynamic-tool schemas crosses a minute
 * routinely, so 60s was not a slow gateway, it was the ordinary case.
 *
 * Two minutes now, matching `MODEL_FIRST_BYTE_DEADLINE_MS_V1` so the kernel's
 * deadline — the one with a sentence written for a person — wins the race and
 * this stays the backstop for a transport that never reaches the seam at all.
 * Both are far inside the fifteen-minute Turn deadline.
 */
export const FROCK_AI_GATEWAY_TIMEOUT_MS_V1 = MODEL_FIRST_BYTE_DEADLINE_MS_V1;

export interface FrockAiBillingLimitV1 {
  inputTokens: number;
  outputTokens: number;
}

export interface FrockAiGatewayConfigV1 {
  /**
   * Each hosted model's prepaid bound, keyed by its Frock AI model id, as the
   * deployment's rate table holds them when the request is sent. A request is
   * held to its own model's bound; one whose model has none — a structured
   * Auto request pinned to a model of its own — to the smallest.
   */
  billingLimits?: () => Promise<Record<string, FrockAiBillingLimitV1>>;
  gatewayId?: string;
  autoRoute?: string;
  /**
   * The Cloudflare account owning the Gateway. Present with `token`, requests
   * take the compat HTTP transport; absent, they take the `AI` binding.
   */
  accountId?: string;
  /** The `cf-aig-authorization` bearer for an authenticated Gateway. */
  token?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Deadline for reaching the Gateway. */
  timeoutMs?: number;
}

export function compatChatCompletionsUrlV1(
  accountId: string,
  gatewayId: string,
): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
}

function retryAfterMillisecondsV1(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * A rejected request answers with a JSON error body rather than an SSE stream.
 * Left unchecked it decodes as a stream that ends before its terminal marker,
 * which the Agent reads as an *uncertain* outcome and parks the run on — so the
 * status is what tells the two apart.
 */
async function streamOrThrowV1(
  response: Response,
  served: Parameters<FrockAiChatCompletionV1>[3],
): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    let reason = detail;
    let code: string | number | undefined;
    try {
      const payload = JSON.parse(detail) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const error = (payload as Record<string, unknown>).error;
        if (typeof error === "string") reason = error;
        else if (error && typeof error === "object" && !Array.isArray(error)) {
          const envelope = error as Record<string, unknown>;
          if (typeof envelope.message === "string") reason = envelope.message;
          if (
            typeof envelope.code === "string" ||
            typeof envelope.code === "number"
          ) {
            code = envelope.code;
          }
        }
      }
    } catch {
      // The bounded non-JSON provider text is still a useful diagnostic.
    }
    throw new FrockAiTransportErrorV1(
      `AI Gateway rejected the request (${response.status})${
        reason ? `: ${reason}` : ""
      }`,
      response.status,
      retryAfterMillisecondsV1(response.headers.get("retry-after")),
      code,
    );
  }
  if (!response.body) {
    throw new Error("AI Gateway did not return a response stream");
  }
  served?.(frockAiServedModelFromHeadersV1(response.headers));
  return response.body;
}

/** The prepaid bounds by the gateway model each Frock AI model is sent as. */
function gatewayBillingLimitsV1(
  limits: Record<string, FrockAiBillingLimitV1>,
  autoRoute: string | null,
): {
  byGatewayModel: Map<string, FrockAiBillingLimitV1>;
  smallest: FrockAiBillingLimitV1;
} {
  const byGatewayModel = new Map<string, FrockAiBillingLimitV1>();
  for (const [model, limit] of Object.entries(limits)) {
    let gatewayModel: string;
    try {
      gatewayModel = gatewayModelForFrockIdV1(model, autoRoute);
    } catch {
      // A priced id this deployment cannot send is never requested.
      continue;
    }
    // Two ids sent as one gateway model are held to the tighter bound.
    const shared = byGatewayModel.get(gatewayModel);
    byGatewayModel.set(
      gatewayModel,
      shared
        ? {
            inputTokens: Math.min(shared.inputTokens, limit.inputTokens),
            outputTokens: Math.min(shared.outputTokens, limit.outputTokens),
          }
        : limit,
    );
  }
  const all = Object.values(limits);
  return {
    byGatewayModel,
    smallest: {
      inputTokens: all.length
        ? Math.min(...all.map((limit) => limit.inputTokens))
        : 0,
      outputTokens: all.length
        ? Math.min(...all.map((limit) => limit.outputTokens))
        : 0,
    },
  };
}

/** Keep the generated Cloudflare binding type on the Worker side of the seam. */
export function createFrockAiGatewayHostV1(
  ai: Pick<Ai, "gateway">,
  config: FrockAiGatewayConfigV1,
): FrockAiGatewayHostV1 {
  const gatewayId = config.gatewayId || DEFAULT_FROCK_AI_GATEWAY_ID_V1;
  const { accountId, token } = config;
  // The `AI` binding's `gateway(...).run()` reaches the Gateway's *universal*
  // endpoint, whose request-shape translation rejects a `dynamic/<route>` model
  // before inference runs — cloudflare/ai#617. Concrete `workers-ai/@cf/...`
  // ids survive that translation, so the binding stays the transport wherever
  // no Gateway credentials are configured, which is every local and CI
  // environment that binds a stand-in for `AI`.
  const useCompat = Boolean(accountId && token);
  // Only the compat transport can carry Auto as a route, so on the binding path
  // this host has none and Auto resolves to a concrete model instead.
  const autoRoute = useCompat
    ? config.autoRoute || FROCK_AI_DEFAULT_AUTO_ROUTE
    : null;
  const timeoutMs = config.timeoutMs ?? FROCK_AI_GATEWAY_TIMEOUT_MS_V1;
  const doFetch = config.fetch ?? fetch;
  return {
    autoRoute,
    async runChatCompletion(gatewayModel, body, signal, served) {
      if (config.billingLimits) {
        const billingLimits = gatewayBillingLimitsV1(
          await config.billingLimits(),
          autoRoute,
        );
        const { inputTokens, outputTokens } =
          billingLimits.byGatewayModel.get(gatewayModel) ??
          billingLimits.smallest;
        // A byte bound overcounts text tokens. Images require a separate model
        // quote; do not silently price their pixels as a short URL.
        const encoded = JSON.stringify(body);
        if (
          encoded.includes('"image_url"') ||
          new TextEncoder().encode(encoded).length + 1024 > inputTokens
        ) {
          throw new FrockAiTransportErrorV1(
            "This request exceeds its prepaid model limit. Use a connected model for this request.",
            400,
          );
        }
        body = { ...body, max_tokens: outputTokens };
      }
      // The deadline is disarmed the moment the response exists, so what it
      // bounds is reaching the gateway and nothing after it. Left armed it
      // aborted the response *body* mid-stream, which is not a gateway that
      // never answered — it is an answer in progress — and the caller has no
      // way to tell the two apart from the abort alone.
      //
      // The caller's `signal` is still chained in, and it is never disarmed:
      // a Stop must tear the request down whether the headers have arrived or
      // not.
      const deadline = new AbortController();
      const timer = setTimeout(() => {
        deadline.abort(
          new Error(`AI Gateway did not respond within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
      const timedOut = (error: unknown): never => {
        if (deadline.signal.aborted && !signal?.aborted) {
          throw deadline.signal.reason as Error;
        }
        throw error;
      };
      const reachGatewayV1 = async (): Promise<ReadableStream<Uint8Array>> => {
        if (useCompat) {
          let response: Response;
          try {
            response = await doFetch(
              compatChatCompletionsUrlV1(accountId!, gatewayId),
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "cf-aig-authorization": `Bearer ${token!}`,
                  // Every answer is billed as the model that produced it; a
                  // cached one would be another request's answer.
                  "cf-aig-skip-cache": "true",
                },
                body: JSON.stringify({ ...body, model: gatewayModel }),
                signal: requestSignal,
              },
            );
          } catch (error) {
            return timedOut(error);
          }
          return streamOrThrowV1(response, served);
        }
        // The `AI` binding takes no signal, so the deadline is raced against
        // the call rather than cancelling it.
        //
        // The loser of that race is cleaned up rather than left hanging. Once
        // the deadline stopped firing on the success path there was nothing
        // left to settle this promise or drop its listener, so every request
        // that answered normally left one of each attached to a signal that
        // lives as long as the Turn. `abandonRace` is what ends it.
        const abandonRace = new AbortController();
        // An RPC-backed binding hands back a stub; left undisposed, it keeps
        // the Durable Object that asked referenced and unevictable.
        const gateway = ai.gateway(gatewayId) as ReturnType<Ai["gateway"]> &
          Partial<Disposable>;
        let response: Response;
        try {
          response = await Promise.race([
            gateway.run({
              provider: "compat",
              endpoint: "chat/completions",
              headers: { "cf-aig-skip-cache": "true" },
              query: { ...body, model: gatewayModel },
            }),
            new Promise<never>((_resolve, reject) => {
              requestSignal.addEventListener(
                "abort",
                () => reject(requestSignal.reason),
                { once: true, signal: abandonRace.signal },
              );
            }),
          ]);
        } catch (error) {
          return timedOut(error);
        } finally {
          abandonRace.abort();
          gateway[Symbol.dispose]?.();
        }
        return streamOrThrowV1(response, served);
      };
      try {
        return await reachGatewayV1();
      } finally {
        // Disarmed here rather than per-branch: whatever happened, the gateway
        // has either answered or failed, and the body is the stream deadline's
        // to bound from now on.
        clearTimeout(timer);
      }
    },
  };
}
