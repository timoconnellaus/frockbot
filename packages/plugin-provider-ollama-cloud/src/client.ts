// Provider metadata is normalized at the shared Connection seam.
import type { ConnectionModelV1 } from "@frockbot/connection-core";

export type OllamaFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OllamaCloudClientConfig {
  apiBaseUrl?: string;
  fetch?: OllamaFetch;
}

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
    try {
      return await response.json();
    } catch {
      throw new Error("Ollama Cloud returned invalid JSON");
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
    const modelIds = payload.models.map((candidate) => {
      const model = object(candidate, "Ollama Cloud model");
      const id =
        typeof model.model === "string"
          ? model.model
          : typeof model.name === "string"
            ? model.name
            : undefined;
      if (!id?.trim()) throw new Error("Ollama Cloud model id is invalid");
      return id;
    });
    return Promise.all(
      [...new Set(modelIds)].map((modelId) =>
        this.resolveModel(apiKey, modelId, signal, "discovered"),
      ),
    );
  }

  async resolveModel(
    apiKey: string,
    providerModelId: string,
    signal?: AbortSignal,
    source: ConnectionModelV1["source"] = "exact-resolution",
  ): Promise<ConnectionModelV1> {
    if (!providerModelId.trim()) throw new Error("Ollama model id is required");
    const payload = object(
      await this.request("/show", apiKey, {
        method: "POST",
        body: JSON.stringify({ model: providerModelId }),
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
    return {
      providerModelId,
      displayName: providerModelId.replace(/:cloud$/, ""),
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
  }
}
