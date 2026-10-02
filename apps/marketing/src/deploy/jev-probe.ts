/**
 * Whether the account can run Jev, asked the only way Jev answers.
 *
 * Jev (`typesafe/jev`) is served to a Worker's `AI` binding and to nothing
 * else: the account's model catalog doesn't list it and the REST `ai/run`
 * route doesn't reach it, even on an account whose Workers run it every Turn.
 * So the probe is a Worker with an `AI` binding, put on the account's
 * `workers.dev` for a few seconds, asked once, and deleted. Like the plan
 * probe it has one fixed name, so a delete that failed leaves a single Worker
 * the next probe overwrites.
 *
 * The call it makes carries no questions. An answer, or a refusal of the input
 * itself, both mean the binding reached Jev; only a refusal of the model says
 * the account can't run it. A refused input spends nothing.
 */
import { CloudflareApiErrorV1, type CloudflareApiV1 } from "./cloudflare-api";
import { randomHexV1 } from "./plan";

export const JEV_PROBE_WORKER_V1 = "frockbot-jev-check";

/** Jev's model on Workers AI, which the install's `AI` binding calls. */
export const JEV_MODEL_V1 = "typesafe/jev";

/** Marks an answer as the probe's own, not a `workers.dev` placeholder. */
export const JEV_PROBE_HEADER_V1 = "x-frockbot-jev-probe";

/**
 * Workers AI's codes for a model this account can't run: no such model, a
 * model agreement not yet accepted, and a private model it isn't allowed.
 */
const MODEL_REFUSED_CODES_V1 = new Set(["5007", "5016", "5018"]);

/** Workers AI's code for an input the model refused, which only Jev can say. */
const INPUT_REFUSED_CODE_V1 = "5006";

export type JevProbeV1 =
  | { readonly state: "ok" }
  | { readonly state: "refused"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

export interface JevProbeOptionsV1 {
  /** The account's `workers.dev` subdomain, made first if it has none. */
  readonly subdomain: () => Promise<string>;
  readonly fetcher: typeof fetch;
  /** How many times to ask before giving up on a new route answering. */
  readonly attempts?: number;
  readonly wait?: (ms: number) => Promise<void>;
}

const PROBE_SOURCE_V1 = `export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/" + env.PROBE_TOKEN) {
      return new Response(null, { status: 404 });
    }
    const headers = { "${JEV_PROBE_HEADER_V1}": "1" };
    try {
      await env.AI.run("${JEV_MODEL_V1}", { state: null, questions: {} });
      return Response.json({ ok: true }, { headers });
    } catch (error) {
      return Response.json(
        { ok: false, message: String(error?.message ?? error) },
        { headers },
      );
    }
  },
};
`;

/** What the binding's answer says about the account. */
export function readJevAnswerV1(answer: unknown): JevProbeV1 {
  const value = answer as { ok?: unknown; message?: unknown } | null;
  if (value?.ok === true) return { state: "ok" };
  const message =
    typeof value?.message === "string" ? value.message : "no answer";
  const code = /\b(\d{4}):/.exec(message)?.[1];
  if (code === INPUT_REFUSED_CODE_V1) return { state: "ok" };
  if (code && MODEL_REFUSED_CODES_V1.has(code)) {
    return { state: "refused", reason: message };
  }
  return { state: "unknown", reason: message };
}

export async function probeJevV1(
  api: CloudflareApiV1,
  accountId: string,
  options: JevProbeOptionsV1,
): Promise<JevProbeV1> {
  const name = JEV_PROBE_WORKER_V1;
  const token = randomHexV1(crypto.getRandomValues(new Uint8Array(16)));
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  try {
    const subdomain = await options.subdomain();
    await api.uploadScript(accountId, name, {
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-08-27",
        bindings: [
          { type: "ai", name: "AI" },
          { type: "plain_text", name: "PROBE_TOKEN", text: token },
        ],
      },
      modules: [
        {
          name: "index.js",
          contentType: "application/javascript+module",
          body: new TextEncoder().encode(PROBE_SOURCE_V1),
        },
      ],
    });
    await api.enableWorkersDev(accountId, name);
    const url = `https://${name}.${subdomain}.workers.dev/${token}`;
    const attempts = options.attempts ?? 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await wait(1500);
      try {
        const response = await options.fetcher(url);
        if (response.headers.get(JEV_PROBE_HEADER_V1)) {
          return readJevAnswerV1(await response.json());
        }
      } catch {
        // A new route can fail to resolve before it answers.
      }
    }
    return {
      state: "unknown",
      reason: "The test Worker didn’t answer on workers.dev yet.",
    };
  } catch (error) {
    return {
      state: "unknown",
      reason:
        error instanceof CloudflareApiErrorV1
          ? error.message
          : "The test Worker couldn’t be set up.",
    };
  } finally {
    await api.deleteScript(accountId, name).catch(() => undefined);
  }
}
