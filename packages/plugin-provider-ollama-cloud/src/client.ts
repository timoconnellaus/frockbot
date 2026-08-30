// Provider metadata is normalized at the shared Connection seam.
import {
  decodeConnectionModelCatalogV1,
  type ConnectionModelV1,
} from "@frockbot/connection-core";

export type OllamaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OllamaCloudClientConfig {
  apiBaseUrl?: string;
  fetch?: OllamaFetch;
}

const MAX_CATALOG_RESPONSE_BYTES = 512 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
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

  constructor(config: OllamaCloudClientConfig = {}) {
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://ollama.com/api").replace(
      /\/$/,
      "",
    );
    this.fetcher = config.fetch ?? fetch;
  }

  private async request(
    path: string,
    apiKey: string,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Ollama Cloud request failed (${response.status})`);
    }
    return boundedJson(
      response,
      path === "/tags" ? MAX_CATALOG_RESPONSE_BYTES : MAX_MODEL_RESPONSE_BYTES,
    );
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
}
