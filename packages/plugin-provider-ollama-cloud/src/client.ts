// Provider metadata is normalized at the shared Connection seam.
import {
  decodeConnectionModelCatalogV1,
  type ConnectionModelV1,
} from "@frockbot/connection-core";

export type OllamaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Every provider call is bounded. A provider that accepts the connection and
 * then never answers is the failure this defends against: without a deadline
 * the connect command's promise never settles and the Connection sits in
 * `authorizing` forever.
 */
export const DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS = 15_000;
/** Inference is slower than a catalog read, so the probe gets its own budget. */
export const DEFAULT_OLLAMA_PROBE_TIMEOUT_MS = 30_000;

export interface OllamaCloudClientConfig {
  /**
   * Endpoint root, without the `/api` or `/v1` path segment: the Package
   * default `https://ollama.com`, an Ollama-compatible host, or a local
   * Ollama server such as `http://127.0.0.1:11434`.
   */
  apiBaseUrl?: string;
  fetch?: OllamaFetch;
  /** Deadline for a catalog or model-detail read. */
  requestTimeoutMs?: number;
  /** Deadline for the authenticated inference probe. */
  probeTimeoutMs?: number;
}

/**
 * Bound one provider call: the caller's signal still cancels it, and a deadline
 * of its own settles it when the provider simply never answers.
 */
export function withDeadlineV1(
  timeoutMs: number,
  signal?: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean } {
  const deadline = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    timedOut: () => deadline.aborted,
  };
}

/** The endpoint every Connection uses until its User points it elsewhere. */
export const DEFAULT_OLLAMA_API_BASE_URL = "https://ollama.com";

const MAX_API_BASE_URL_LENGTH = 2048;

/**
 * Decode a User-supplied Ollama endpoint root at its seam.
 *
 * An endpoint is an absolute `http:` or `https:` URL with no credentials, no
 * query, and no fragment. The trailing slash is stripped so `${root}/api/tags`
 * and `${root}/v1` compose without a doubled separator.
 */
export function decodeOllamaApiBaseUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_API_BASE_URL_LENGTH
  ) {
    throw new Error(
      "Ollama endpoint must be an absolute http or https URL, for example https://ollama.com",
    );
  }
  const candidate = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      `Ollama endpoint "${candidate}" is not an absolute http or https URL`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Ollama endpoint "${candidate}" must use http or https, not ${parsed.protocol.replace(":", "")}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Ollama endpoint must not carry credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Ollama endpoint must not carry a query or fragment");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

const MAX_CATALOG_RESPONSE_BYTES = 512 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const MAX_PROBE_FAILURE_TEXT = 200;
// The smallest completion Ollama Cloud will produce: one predicted token.
const PROBE_PREDICTED_TOKENS = 1;
const MAX_CONNECTION_MODELS = 100;
const MODEL_LOOKUP_CONCURRENCY = 4;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function modelId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Ollama Cloud model id is invalid");
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error("Ollama Cloud model id is invalid");
  }
  return normalized;
}

async function boundedJson(
  response: Response,
  maximum: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new Error("Ollama Cloud response is too large");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("Ollama Cloud response is too large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Ollama Cloud returned invalid JSON");
  }
}

async function boundedText(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (length <= MAX_PROBE_FAILURE_TEXT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      chunks.push(chunk.value);
    }
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(
    chunks.reduce((total, c) => total + c.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes).slice(0, MAX_PROBE_FAILURE_TEXT);
  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const reported = (payload as Record<string, unknown>).error;
      if (typeof reported === "string" && reported.trim())
        return reported.trim();
    }
  } catch {
    // A non-JSON body is reported verbatim; the provider owes us no shape here.
  }
  return text.trim();
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await transform(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

export class OllamaCloudClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: OllamaFetch;
  private readonly requestTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(config: OllamaCloudClientConfig = {}) {
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS;
    this.probeTimeoutMs =
      config.probeTimeoutMs ?? DEFAULT_OLLAMA_PROBE_TIMEOUT_MS;
    this.apiBaseUrl = `${decodeOllamaApiBaseUrl(
      config.apiBaseUrl ?? DEFAULT_OLLAMA_API_BASE_URL,
    )}/api`;
    // Workerd rejects a detached global `fetch` ("Illegal invocation"), so the
    // default fetcher forwards through a closure rather than aliasing it.
    this.fetcher =
      config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async request(
    path: string,
    apiKey: string,
    init: RequestInit,
  ): Promise<unknown> {
    const deadline = withDeadlineV1(
      this.requestTimeoutMs,
      init.signal ?? undefined,
    );
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
        ...init,
        signal: deadline.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      throw deadline.timedOut()
        ? new Error(
            `Ollama Cloud did not answer within ${this.requestTimeoutMs}ms`,
          )
        : error;
    }
    if (!response.ok) {
      throw new Error(`Ollama Cloud request failed (${response.status})`);
    }
    try {
      return await boundedJson(
        response,
        path === "/tags"
          ? MAX_CATALOG_RESPONSE_BYTES
          : MAX_MODEL_RESPONSE_BYTES,
      );
    } catch (error) {
      throw deadline.timedOut()
        ? new Error(
            `Ollama Cloud did not answer within ${this.requestTimeoutMs}ms`,
          )
        : error;
    }
  }

  async listModels(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<ConnectionModelV1[]> {
    const payload = object(
      await this.request("/tags", apiKey, { method: "GET", signal }),
      "Ollama Cloud model catalog",
    );
    if (!Array.isArray(payload.models)) {
      throw new Error("Ollama Cloud model catalog is invalid");
    }
    const modelIds = new Set<string>();
    for (const candidate of payload.models) {
      const model = object(candidate, "Ollama Cloud model");
      modelIds.add(modelId(model.model ?? model.name));
      if (modelIds.size >= MAX_CONNECTION_MODELS) break;
    }
    return mapConcurrent([...modelIds], MODEL_LOOKUP_CONCURRENCY, (id) =>
      this.resolveModel(apiKey, id, signal, "discovered"),
    );
  }

  async resolveModel(
    apiKey: string,
    providerModelId: string,
    signal?: AbortSignal,
    source: ConnectionModelV1["source"] = "exact-resolution",
  ): Promise<ConnectionModelV1> {
    const normalizedProviderModelId = modelId(providerModelId);
    const payload = object(
      await this.request("/show", apiKey, {
        method: "POST",
        body: JSON.stringify({ model: normalizedProviderModelId }),
        signal,
      }),
      "Ollama Cloud model details",
    );
    const capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter(
          (candidate): candidate is string => typeof candidate === "string",
        )
      : [];
    const modelInfo =
      payload.model_info &&
      typeof payload.model_info === "object" &&
      !Array.isArray(payload.model_info)
        ? (payload.model_info as Record<string, unknown>)
        : {};
    const contextWindow = Object.entries(modelInfo)
      .filter(([key]) => key.endsWith(".context_length"))
      .map(([, value]) => positiveInteger(value))
      .find((value): value is number => value !== undefined);
    const normalized = {
      providerModelId: normalizedProviderModelId,
      displayName: normalizedProviderModelId.replace(/:cloud$/, ""),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      capabilities: {
        tools: capabilities.includes("tools"),
        vision: capabilities.includes("vision"),
        reasoning:
          capabilities.includes("thinking") ||
          capabilities.includes("reasoning"),
      },
      source,
    };
    const validated = decodeConnectionModelCatalogV1({
      schemaVersion: 1,
      generation: "validation",
      state: "fresh",
      models: [normalized],
    }).models[0];
    if (!validated) throw new Error("Ollama Cloud model is invalid");
    return validated;
  }

  /**
   * Prove an API key is authorized for inference.
   *
   * Measured against https://ollama.com on 2026-08-31 and recorded in
   * `docs/research/ollama-cloud-auth.md`: `GET /api/tags`, `GET /v1/models`,
   * and `POST /api/show` answer 200 for a valid key, a garbage key, and no key
   * at all, so no catalog read can validate a key. `POST /api/chat` does
   * authenticate: 401 `{"error":"Unauthorized"}` for a bad or absent key, 200
   * for a valid one. A one-token completion is the cheapest authenticated call
   * (~70 tokens of usage, `done_reason: "length"`).
   *
   * The assistant content is never parsed or retained; only the shape of the
   * response is confirmed.
   */
  async probeInference(
    apiKey: string,
    providerModelId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const model = modelId(providerModelId);
    const deadline = withDeadlineV1(this.probeTimeoutMs, signal);
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiBaseUrl}/chat`, {
        method: "POST",
        signal: deadline.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          options: { num_predict: PROBE_PREDICTED_TOKENS },
        }),
      });
    } catch (error) {
      throw deadline.timedOut()
        ? new Error(
            `Ollama Cloud did not answer within ${this.probeTimeoutMs}ms`,
          )
        : error;
    }
    if (!response.ok) {
      const reported = await boundedText(response);
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Ollama Cloud rejected the key for inference: ${reported || `HTTP ${response.status}`}`,
        );
      }
      throw new Error(
        `Ollama Cloud inference probe failed (${response.status})${reported ? `: ${reported}` : ""}`,
      );
    }
    const payload = object(
      await boundedJson(response, MAX_PROBE_RESPONSE_BYTES),
      "Ollama Cloud inference probe",
    );
    if (typeof payload.error === "string") {
      throw new Error(
        `Ollama Cloud rejected the key for inference: ${payload.error.slice(0, MAX_PROBE_FAILURE_TEXT)}`,
      );
    }
  }
}
