import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  workersAiJevFetchV1,
  type JevAiBindingV1,
} from "../supervision/jev.js";

// Jev for the labelled runs. Workers AI is the transport production uses, so
// it is preferred: its REST API stands in for the `AI` binding a Worker has.
// TypeSafe's own API answers when only a Jev key is set. Each answer's model
// names the transport that resolved it (`workers-ai:<version>` on Workers AI),
// so a report says which one it measured.

export const EVAL_JEV_SETUP_HINT_V1 =
  "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI), or JEV_API_KEY, in the main checkout's .dev.vars";

/** The `AI` binding's `run`, over Workers AI's REST API. */
export function workersAiRestBindingV1(
  accountId: string,
  apiToken: string,
): JevAiBindingV1 {
  return {
    async run(model, input, options) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input }),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        { success?: boolean; result?: unknown; errors?: unknown } | undefined;
      if (!response.ok || body?.success === false || !body) {
        throw new Error(
          `Workers AI answered ${response.status}: ${JSON.stringify(body?.errors ?? body)}`,
        );
      }
      return body.result;
    },
  };
}

export interface EvalJevClientOptionsV1 {
  readonly defaultModel: string;
  readonly retry?: { readonly maxRetries: number };
  readonly timeout?: number;
}

/** A client for the run, or `undefined` when no credential is set. */
export function evalJevClientV1(
  env: Record<string, string | undefined>,
  options: EvalJevClientOptionsV1,
): TypeSafeClient | undefined {
  const settings = {
    defaultModel: options.defaultModel,
    retry: options.retry ?? { maxRetries: 0 },
    timeout: options.timeout ?? 30_000,
    // `debug` logs request bodies, which are conversation evidence.
    logLevel: "off" as const,
  };
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (accountId && apiToken) {
    return new TypeSafeClient({
      ...settings,
      // The client refuses to construct without one; nothing sends it.
      apiKey: "workers-ai",
      fetch: workersAiJevFetchV1(workersAiRestBindingV1(accountId, apiToken)),
    });
  }
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) return undefined;
  const baseURL = (env.JEV_BASE_URL ?? "").trim();
  return new TypeSafeClient({
    ...settings,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

/** The same, for a run that has nothing to report without one. */
export function requiredEvalJevClientV1(
  env: Record<string, string | undefined>,
  options: EvalJevClientOptionsV1,
): TypeSafeClient {
  const client = evalJevClientV1(env, options);
  if (!client) throw new Error(EVAL_JEV_SETUP_HINT_V1);
  return client;
}
