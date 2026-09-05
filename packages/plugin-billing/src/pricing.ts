import type { LlmUsageV1 } from "@frockbot/kernel-contracts";

/** Immutable price snapshot used by every entry written by this release. */
export const MODEL_PRICE_TABLE_VERSION_V1 = "2026-09-04";

/** Platform markup. One means the User sees provider cost with no markup. */
export const PLATFORM_COST_MULTIPLIER_V1 = 1;

/** A deliberately conservative fallback for a model absent from the table. */
export const UNKNOWN_MODEL_PRICE_V1 = {
  inputUsdPerMillion: 10,
  cachedInputUsdPerMillion: 10,
  outputUsdPerMillion: 50,
} as const;

export interface ModelPriceV1 {
  provider: string;
  model: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  outputUsdPerMillion: number;
  sourceUrl: string;
}

const OPENAI_SOURCE = "https://developers.openai.com/api/docs/models/compare";
const CLOUDFLARE_SOURCE =
  "https://developers.cloudflare.com/workers-ai/platform/pricing/";
const OLLAMA_SOURCE = "https://ollama.com/cloud";

/**
 * Provider/model prices in dollars per million tokens.
 *
 * Ollama's two DeepSeek models use its published peak prices so a static
 * ledger never understates a request made during the peak window.
 */
export const MODEL_PRICE_TABLE_V1: readonly ModelPriceV1[] = [
  {
    provider: "foundation",
    model: "deterministic-v1",
    inputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    sourceUrl: "https://github.com/timoconnellaus/frockbot",
  },
  {
    provider: "flock-ai",
    model: "@frock/deepseek-ai/deepseek-v4-flash-0731",
    inputUsdPerMillion: 0.44,
    cachedInputUsdPerMillion: 0.014,
    outputUsdPerMillion: 1.32,
    sourceUrl: CLOUDFLARE_SOURCE,
  },
  /*
   * Auto is what almost every Bot runs on, and it was absent from this table:
   * every platform-model Turn was priced at the unknown-model fallback, which
   * is $10/$50 per million — twenty-three times what the model it routes to
   * actually costs. Two short Turns read as fifty cents.
   *
   * Auto is a Cloudflare AI Gateway dynamic route over Frock AI's text
   * models, and Frock AI publishes exactly one, so the route's price is that
   * model's price. A second text model would make this an approximation and
   * the honest fix then is to record the model the route chose.
   */
  {
    provider: "flock-ai",
    model: "@frock/auto",
    inputUsdPerMillion: 0.44,
    cachedInputUsdPerMillion: 0.014,
    outputUsdPerMillion: 1.32,
    sourceUrl: CLOUDFLARE_SOURCE,
  },
  ...[
    ["gpt-6-astra", 10, 1, 50],
    ["gpt-5.6", 4, 0.4, 20],
    ["gpt-5.6-sol", 4, 0.4, 20],
    ["gpt-5.6-terra", 2, 0.2, 12],
    ["gpt-5.6-luna", 0.2, 0.02, 1.2],
  ].map(([model, input, cached, output]) => ({
    provider: "openai-compatible",
    model: String(model),
    inputUsdPerMillion: Number(input),
    cachedInputUsdPerMillion: Number(cached),
    outputUsdPerMillion: Number(output),
    sourceUrl: OPENAI_SOURCE,
  })),
  ...[
    ["deepseek-v4-flash", 0.44, 0.014, 1.32],
    ["deepseek-v4-pro", 1.32, 0.044, 3.96],
    ["gemma4", 0.14, 0.05, 0.4],
    ["glm-5.3", 1.4, 0.26, 4.4],
    ["glm-5.3-flash", 0.15, 0.03, 0.5],
    ["glm-5.2", 1.4, 0.26, 4.4],
    ["glm-5.1", 1, 0.2, 3.2],
    ["gpt-oss:120b", 0.15, 0.014, 0.6],
    ["gpt-oss:20b", 0.07, 0.035, 0.3],
    ["kimi-k3", 3, 0.3, 15],
    ["kimi-k2.7-code", 0.95, 0.19, 4],
    ["kimi-k2.6", 0.95, 0.16, 4],
    ["minimax-m3", 0.6, 0.12, 2.4],
    ["minimax-m2.7", 0.3, 0.06, 1.2],
    ["mistral-large-3", 0.5, 0.5, 1.5],
    ["qwen3.5:397b", 0.6, 0.6, 3.6],
  ].map(([model, input, cached, output]) => ({
    provider: "ollama-cloud",
    model: String(model),
    inputUsdPerMillion: Number(input),
    cachedInputUsdPerMillion: Number(cached),
    outputUsdPerMillion: Number(output),
    sourceUrl: OLLAMA_SOURCE,
  })),
] as const;

export interface ResolvedModelPriceV1 {
  price: Omit<ModelPriceV1, "provider" | "model" | "sourceUrl">;
  unknown: boolean;
  priceTableVersion: string;
}

function canonicalModelV1(provider: string, model: string): string {
  if (provider === "ollama-cloud") return model.replace(/:cloud$/, "");
  if (provider === "flock-ai" && model.startsWith("@flock/")) {
    return `@frock/${model.slice("@flock/".length)}`;
  }
  return model;
}

export function resolveModelPriceV1(
  provider: string,
  model: string,
): ResolvedModelPriceV1 {
  const canonical = canonicalModelV1(provider, model);
  const found = MODEL_PRICE_TABLE_V1.find(
    (entry) => entry.provider === provider && entry.model === canonical,
  );
  const price = found ?? UNKNOWN_MODEL_PRICE_V1;
  return {
    price: {
      inputUsdPerMillion: price.inputUsdPerMillion,
      ...(price.cachedInputUsdPerMillion === undefined
        ? {}
        : { cachedInputUsdPerMillion: price.cachedInputUsdPerMillion }),
      outputUsdPerMillion: price.outputUsdPerMillion,
    },
    unknown: found === undefined,
    priceTableVersion: MODEL_PRICE_TABLE_VERSION_V1,
  };
}

/** One micro-dollar is one millionth of a dollar. */
export function modelCostMicrosV1(
  provider: string,
  model: string,
  usage: LlmUsageV1,
): ResolvedModelPriceV1 & { costMicros: number } {
  const resolved = resolveModelPriceV1(provider, model);
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const cost =
    uncached * resolved.price.inputUsdPerMillion +
    cached *
      (resolved.price.cachedInputUsdPerMillion ??
        resolved.price.inputUsdPerMillion) +
    usage.outputTokens * resolved.price.outputUsdPerMillion;
  return {
    ...resolved,
    costMicros: Math.round(cost * PLATFORM_COST_MULTIPLIER_V1),
  };
}

/** OpenAI's published realtime transcription price, billed by duration. */
export const VOICE_USD_PER_MINUTE_V1 = 0.017;
export const VOICE_PRICE_SOURCE_V1 =
  "https://developers.openai.com/api/docs/models/gpt-live-transcribe";

export function voiceCostMicrosV1(seconds: number): number {
  return Math.round(
    (seconds / 60) *
      VOICE_USD_PER_MINUTE_V1 *
      1_000_000 *
      PLATFORM_COST_MULTIPLIER_V1,
  );
}

/**
 * Prices one cumulative voice receipt without making the result depend on how
 * often the session reported. The sum of every increment therefore equals the
 * rounded price of the final cumulative duration.
 */
export function voiceIncrementCostMicrosV1(
  sessionSeconds: number,
  recordedSeconds: number,
): number {
  const previousSeconds = sessionSeconds - recordedSeconds;
  return voiceCostMicrosV1(sessionSeconds) - voiceCostMicrosV1(previousSeconds);
}
