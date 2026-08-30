import { decodeBotIdV1 } from "@frockbot/configuration-core";
import { decodeRunIdV1 } from "@frockbot/plugin-shell/backend-contracts";

type RpcValueDecoder = (value: unknown, label: string) => unknown;
export type RpcJsonValue =
  | null
  | boolean
  | number
  | string
  | RpcJsonValue[]
  | { [key: string]: RpcJsonValue };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeRpcEnvelopeV1(
  input: unknown,
  required: Readonly<Record<string, RpcValueDecoder>>,
  optional: Readonly<Record<string, RpcValueDecoder>> = {},
): Record<string, unknown> {
  const value = record(input, "RPC request");
  const allowed = new Set([
    "schemaVersion",
    ...Object.keys(required),
    ...Object.keys(optional),
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Object.keys(required).every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error("RPC request is invalid");
  }
  const decoded: Record<string, unknown> = { schemaVersion: 1 };
  for (const [key, decoder] of Object.entries(required)) {
    decoded[key] = decoder(value[key], `RPC request.${key}`);
  }
  for (const [key, decoder] of Object.entries(optional)) {
    if (value[key] !== undefined) {
      decoded[key] = decoder(value[key], `RPC request.${key}`);
    }
  }
  return decoded;
}

export function rpcString(maximum = 4_096): RpcValueDecoder {
  return (value, label) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum
    ) {
      throw new Error(`${label} must be a bounded non-empty string`);
    }
    return value;
  };
}

export const rpcIdentifier: RpcValueDecoder = (value, label) => {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} must be an identifier`);
  }
  return value;
};

export const rpcBotId: RpcValueDecoder = (value, label) => {
  try {
    return decodeBotIdV1(value);
  } catch {
    throw new Error(`${label} must be a Bot ID`);
  }
};

export function rpcEnum<const T extends readonly string[]>(
  values: T,
): RpcValueDecoder {
  return (value, label) => {
    if (typeof value !== "string" || !values.includes(value)) {
      throw new Error(`${label} is invalid`);
    }
    return value;
  };
}

export const rpcBoolean: RpcValueDecoder = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
};

export function rpcObject(
  required: Readonly<Record<string, RpcValueDecoder>>,
  optional: Readonly<Record<string, RpcValueDecoder>> = {},
): RpcValueDecoder {
  return (value, label) => {
    const source = record(value, label);
    const allowed = new Set([
      ...Object.keys(required),
      ...Object.keys(optional),
    ]);
    if (
      !Object.keys(required).every((key) => Object.hasOwn(source, key)) ||
      !Object.keys(source).every((key) => allowed.has(key))
    ) {
      throw new Error(`${label} is invalid`);
    }
    const decoded: Record<string, unknown> = {};
    for (const [key, decoder] of Object.entries(required)) {
      decoded[key] = decoder(source[key], `${label}.${key}`);
    }
    for (const [key, decoder] of Object.entries(optional)) {
      if (source[key] !== undefined) {
        decoded[key] = decoder(source[key], `${label}.${key}`);
      }
    }
    return decoded;
  };
}

function cloneJson(value: unknown, label: string, depth: number): RpcJsonValue {
  if (depth > 8) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 8_192) throw new Error(`${label} is too long`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} has too many values`);
    return value.map((entry, index) =>
      cloneJson(entry, `${label}[${index}]`, depth + 1),
    );
  }
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 256) throw new Error(`${label} has too many fields`);
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      if (!key || key.length > 128)
        throw new Error(`${label} has an invalid key`);
      return [key, cloneJson(entry, `${label}.${key}`, depth + 1)];
    }),
  );
}

export const rpcJsonRecord: RpcValueDecoder = (value, label) =>
  cloneJson(record(value, label), label, 0);

export function rpcDecoded(
  decoder: (input: unknown) => unknown,
): RpcValueDecoder {
  return (value) => decoder(value);
}

export interface DecodedStartConnectionRpcV1 {
  schemaVersion: 1;
  userId: string;
  connection: {
    connectionId: string;
    packageId: string;
    connectionTypeId: string;
    displayName: string;
    safeMetadata?: { [key: string]: RpcJsonValue };
  };
}

export function decodeStartConnectionRpcV1(
  input: unknown,
): DecodedStartConnectionRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    connection: rpcObject(
      {
        connectionId: rpcIdentifier,
        packageId: rpcIdentifier,
        connectionTypeId: rpcIdentifier,
        displayName: rpcString(256),
      },
      { safeMetadata: rpcJsonRecord },
    ),
  });
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    connection: request.connection as DecodedStartConnectionRpcV1["connection"],
  };
}

export interface DecodedBotRunRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    sessionId: string;
    acceptedAt: string;
    text: string;
  };
}

export function decodeBotRunRpcV1(input: unknown): DecodedBotRunRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      runId: rpcString(128),
      sessionId: rpcString(257),
      acceptedAt: rpcString(64),
      text: rpcString(32_000),
    }),
  });
  const command = request.command as DecodedBotRunRpcV1["command"];
  command.runId = decodeRunIdV1(command.runId);
  if (!Number.isFinite(Date.parse(command.acceptedAt))) {
    throw new Error("RPC request.command.acceptedAt is invalid");
  }
  if (new TextEncoder().encode(command.text).byteLength > 32_000) {
    throw new Error("RPC request.command.text is invalid");
  }
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}
