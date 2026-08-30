import type {
  ConnectionAuthorizationKind,
  CredentialDescriptorV1,
} from "./credentials.js";

export interface ModelCapabilityV1 {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

export const MAX_CONNECTION_MODELS_V1 = 100;

export interface ConnectionModelV1 {
  providerModelId: string;
  displayName: string;
  contextWindow?: number;
  capabilities: ModelCapabilityV1;
  source: "discovered" | "exact-resolution";
}

export interface ConnectionModelCatalogV1 {
  schemaVersion: 1;
  generation: string;
  state: "fresh" | "stale" | "refreshing" | "failed";
  models: ConnectionModelV1[];
  refreshedAt?: string;
  refreshAfter?: string;
  failure?: string;
}

export interface ConnectionAuthorizationViewV1 {
  schemaVersion: 1;
  kind: ConnectionAuthorizationKind;
  credential: CredentialDescriptorV1;
}

export interface CreateApiKeyConnectionCommandV1 {
  schemaVersion: 1;
  type: "connection/create-api-key";
  commandId: string;
  packageId: string;
  connectionTypeId: string;
  label: string;
  apiKey: string;
}

export interface RotateApiKeyConnectionCommandV1 {
  schemaVersion: 1;
  type: "connection/rotate-api-key";
  commandId: string;
  connectionId: string;
  apiKey: string;
}

export interface UpdateConnectionLabelCommandV1 {
  schemaVersion: 1;
  type: "connection/update-label";
  commandId: string;
  connectionId: string;
  label: string;
}

export interface RefreshConnectionCatalogCommandV1 {
  schemaVersion: 1;
  type: "connection/refresh-models";
  commandId: string;
  connectionId: string;
}

export interface SetConnectionEnabledCommandV1 {
  schemaVersion: 1;
  type: "connection/set-enabled";
  commandId: string;
  connectionId: string;
  enabled: boolean;
}

export interface DisconnectConnectionCommandV1 {
  schemaVersion: 1;
  type: "connection/disconnect";
  commandId: string;
  connectionId: string;
  revokeUpstream: boolean;
}

export type ConnectionCommandV1 =
  | CreateApiKeyConnectionCommandV1
  | RotateApiKeyConnectionCommandV1
  | UpdateConnectionLabelCommandV1
  | RefreshConnectionCatalogCommandV1
  | SetConnectionEnabledCommandV1
  | DisconnectConnectionCommandV1;

export interface ConnectionCommandReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  connectionId: string;
  status: "applied" | "failed" | "reconciliation-required";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const expected = new Set(required);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new Error("Connection command has invalid fields");
  }
}

const CONNECTION_COMMAND_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function decodeConnectionCommandIdV1(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_COMMAND_ID_PATTERN.test(value)) {
    throw new Error("commandId is invalid");
  }
  return value;
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function common(value: Record<string, unknown>): {
  schemaVersion: 1;
  commandId: string;
} {
  if (value.schemaVersion !== 1) {
    throw new Error("Connection command schemaVersion must be 1");
  }
  return {
    schemaVersion: 1,
    commandId: decodeConnectionCommandIdV1(value.commandId),
  };
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const decoded = text(value, label, 64);
  if (!Number.isFinite(Date.parse(decoded))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return decoded;
}

export function decodeConnectionAuthorizationViewV1(
  input: unknown,
): ConnectionAuthorizationViewV1 {
  const value = record(input, "Connection authorization");
  exact(value, ["schemaVersion", "kind", "credential"]);
  const kinds: ConnectionAuthorizationKind[] = [
    "none",
    "api-key",
    "ambient-native",
    "grant",
  ];
  if (value.schemaVersion !== 1 || !kinds.includes(value.kind as never)) {
    throw new Error("Connection authorization is invalid");
  }
  const credential = record(value.credential, "credential");
  const allowed = new Set([
    "schemaVersion",
    "configured",
    "source",
    "writable",
    "generation",
    "updatedAt",
  ]);
  if (
    credential.schemaVersion !== 1 ||
    typeof credential.configured !== "boolean" ||
    typeof credential.writable !== "boolean" ||
    !kinds.includes(credential.source as never) ||
    Object.keys(credential).some((key) => !allowed.has(key))
  ) {
    throw new Error("credential descriptor is invalid");
  }
  return {
    schemaVersion: 1,
    kind: value.kind as ConnectionAuthorizationKind,
    credential: {
      schemaVersion: 1,
      configured: credential.configured,
      source: credential.source as ConnectionAuthorizationKind,
      writable: credential.writable,
      ...(credential.generation === undefined
        ? {}
        : { generation: text(credential.generation, "generation", 128) }),
      ...(credential.updatedAt === undefined
        ? {}
        : {
            updatedAt: optionalTimestamp(
              credential.updatedAt,
              "credential.updatedAt",
            ),
          }),
    },
  };
}

export function decodeConnectionModelCatalogV1(
  input: unknown,
): ConnectionModelCatalogV1 {
  const value = record(input, "Connection model catalog");
  const allowed = new Set([
    "schemaVersion",
    "generation",
    "state",
    "models",
    "refreshedAt",
    "refreshAfter",
    "failure",
  ]);
  const states: ConnectionModelCatalogV1["state"][] = [
    "fresh",
    "stale",
    "refreshing",
    "failed",
  ];
  if (
    value.schemaVersion !== 1 ||
    !states.includes(value.state as never) ||
    !Array.isArray(value.models) ||
    value.models.length > MAX_CONNECTION_MODELS_V1 ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("Connection model catalog is invalid");
  }
  const models = value.models.map((candidate) => {
    const model = record(candidate, "Connection model");
    exact(model, [
      "providerModelId",
      "displayName",
      "capabilities",
      "source",
      ...(Object.hasOwn(model, "contextWindow") ? ["contextWindow"] : []),
    ]);
    const capabilities = record(model.capabilities, "model capabilities");
    exact(capabilities, ["tools", "vision", "reasoning"]);
    if (
      typeof capabilities.tools !== "boolean" ||
      typeof capabilities.vision !== "boolean" ||
      typeof capabilities.reasoning !== "boolean" ||
      (model.source !== "discovered" && model.source !== "exact-resolution") ||
      (model.contextWindow !== undefined &&
        (typeof model.contextWindow !== "number" ||
          !Number.isSafeInteger(model.contextWindow) ||
          model.contextWindow <= 0))
    ) {
      throw new Error("Connection model is invalid");
    }
    return {
      providerModelId: text(model.providerModelId, "providerModelId", 256),
      displayName: text(model.displayName, "displayName", 256),
      ...(model.contextWindow === undefined
        ? {}
        : { contextWindow: model.contextWindow as number }),
      capabilities: {
        tools: capabilities.tools,
        vision: capabilities.vision,
        reasoning: capabilities.reasoning,
      },
      source: model.source,
    } satisfies ConnectionModelV1;
  });
  return {
    schemaVersion: 1,
    generation: text(value.generation, "generation", 128),
    state: value.state as ConnectionModelCatalogV1["state"],
    models,
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: optionalTimestamp(value.refreshedAt, "refreshedAt") }),
    ...(value.refreshAfter === undefined
      ? {}
      : {
          refreshAfter: optionalTimestamp(value.refreshAfter, "refreshAfter"),
        }),
    ...(value.failure === undefined
      ? {}
      : { failure: text(value.failure, "failure", 2_000) }),
  };
}

export function decodeConnectionCommandReceiptV1(
  input: unknown,
): ConnectionCommandReceiptV1 {
  const value = record(input, "Connection command receipt");
  exact(value, ["schemaVersion", "commandId", "connectionId", "status"]);
  const statuses: ConnectionCommandReceiptV1["status"][] = [
    "applied",
    "failed",
    "reconciliation-required",
  ];
  if (value.schemaVersion !== 1 || !statuses.includes(value.status as never)) {
    throw new Error("Connection command receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: decodeConnectionCommandIdV1(value.commandId),
    connectionId: text(value.connectionId, "connectionId", 128),
    status: value.status as ConnectionCommandReceiptV1["status"],
  };
}

export function decodeConnectionCommandV1(input: unknown): ConnectionCommandV1 {
  const value = record(input, "Connection command");
  const base = common(value);
  switch (value.type) {
    case "connection/create-api-key":
      exact(value, [
        "schemaVersion",
        "type",
        "commandId",
        "packageId",
        "connectionTypeId",
        "label",
        "apiKey",
      ]);
      return {
        ...base,
        type: value.type,
        packageId: text(value.packageId, "packageId", 128),
        connectionTypeId: text(value.connectionTypeId, "connectionTypeId", 128),
        label: text(value.label, "label", 120),
        apiKey: text(value.apiKey, "apiKey", 16_384),
      };
    case "connection/rotate-api-key":
      exact(value, [
        "schemaVersion",
        "type",
        "commandId",
        "connectionId",
        "apiKey",
      ]);
      return {
        ...base,
        type: value.type,
        connectionId: text(value.connectionId, "connectionId", 128),
        apiKey: text(value.apiKey, "apiKey", 16_384),
      };
    case "connection/update-label":
      exact(value, [
        "schemaVersion",
        "type",
        "commandId",
        "connectionId",
        "label",
      ]);
      return {
        ...base,
        type: value.type,
        connectionId: text(value.connectionId, "connectionId", 128),
        label: text(value.label, "label", 120),
      };
    case "connection/refresh-models":
      exact(value, ["schemaVersion", "type", "commandId", "connectionId"]);
      return {
        ...base,
        type: value.type,
        connectionId: text(value.connectionId, "connectionId", 128),
      };
    case "connection/set-enabled":
      exact(value, [
        "schemaVersion",
        "type",
        "commandId",
        "connectionId",
        "enabled",
      ]);
      if (typeof value.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      return {
        ...base,
        type: value.type,
        connectionId: text(value.connectionId, "connectionId", 128),
        enabled: value.enabled,
      };
    case "connection/disconnect":
      exact(value, [
        "schemaVersion",
        "type",
        "commandId",
        "connectionId",
        "revokeUpstream",
      ]);
      if (typeof value.revokeUpstream !== "boolean") {
        throw new Error("revokeUpstream must be a boolean");
      }
      return {
        ...base,
        type: value.type,
        connectionId: text(value.connectionId, "connectionId", 128),
        revokeUpstream: value.revokeUpstream,
      };
    default:
      throw new Error("Connection command type is unsupported");
  }
}
