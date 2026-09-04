import { MODEL_FIRST_BYTE_DEADLINE_MS_V1 } from "@frockbot/kernel-contracts";
import { FROCK_AI_DEFAULT_AUTO_ROUTE } from "@frockbot/plugin-provider-frock-ai/catalog";

export const DEFAULT_FROCK_AI_GATEWAY_ID_V1 = "flock";

export interface FrockAiGatewayHostV1 {
  autoRoute: string;
  runChatCompletion(
    gatewayModel: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
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
 * carries the applets SKILL.md plus the dynamic-tool schemas crosses a minute
 * routinely, so 60s was not a slow gateway, it was the ordinary case.
 *
 * Two minutes now, matching `MODEL_FIRST_BYTE_DEADLINE_MS_V1` so the kernel's
 * deadline — the one with a sentence written for a person — wins the race and
 * this stays the backstop for a transport that never reaches the seam at all.
 * Both are far inside the fifteen-minute Turn deadline.
 */
export const FROCK_AI_GATEWAY_TIMEOUT_MS_V1 = MODEL_FIRST_BYTE_DEADLINE_MS_V1;

export interface FrockAiGatewayConfigV1 {
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

/**
 * A rejected request answers with a JSON error body rather than an SSE stream.
 * Left unchecked it decodes as a stream that ends before its terminal marker,
 * which the Agent reads as an *uncertain* outcome and parks the run on — so the
 * status is what tells the two apart.
 */
async function streamOrThrowV1(
  response: Response,
): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    throw new Error(
      `AI Gateway rejected the request (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  if (!response.body) {
    throw new Error("AI Gateway did not return a response stream");
  }
  return response.body;
}

/** Keep the generated Cloudflare binding type on the Worker side of the seam. */
export function createFrockAiGatewayHostV1(
  ai: Pick<Ai, "gateway">,
  config: FrockAiGatewayConfigV1,
): FrockAiGatewayHostV1 {
  const gatewayId = config.gatewayId || DEFAULT_FROCK_AI_GATEWAY_ID_V1;
  const autoRoute = config.autoRoute || FROCK_AI_DEFAULT_AUTO_ROUTE;
  const { accountId, token } = config;
  // The `AI` binding's `gateway(...).run()` reaches the Gateway's *universal*
  // endpoint, whose request-shape translation rejects a `dynamic/<route>` model
  // before inference runs — cloudflare/ai#617. Concrete `workers-ai/@cf/...`
  // ids survive that translation, so the binding stays the transport wherever
  // no Gateway credentials are configured, which is every local and CI
  // environment that binds a stand-in for `AI`.
  const useCompat = Boolean(accountId && token);
  const timeoutMs = config.timeoutMs ?? FROCK_AI_GATEWAY_TIMEOUT_MS_V1;
  const doFetch = config.fetch ?? fetch;
  return {
    autoRoute,
    async runChatCompletion(gatewayModel, body, signal) {
      // The deadline is disarmed the moment the response exists, so what it
      // bounds is reaching the gateway and nothing after it. Left armed it
      // aborted the response *body* mid-stream, which is not a gateway that
      // never answered — it is an answer in progress — and the caller has no
      // way to tell the two apart from the abort alone.
      //
      // The caller's `signal` is still chained in, and it is never disarmed:
      // a Stop or a superseding message must tear the request down whether the
      // headers have arrived or not.
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
                },
                body: JSON.stringify({ ...body, model: gatewayModel }),
                signal: requestSignal,
              },
            );
          } catch (error) {
            return timedOut(error);
          }
          return streamOrThrowV1(response);
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
        let response: Response;
        try {
          response = await Promise.race([
            ai.gateway(gatewayId).run({
              provider: "compat",
              endpoint: "chat/completions",
              headers: {},
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
        }
        return streamOrThrowV1(response);
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
