import { decodeSkillRefsV1, type SkillRefV1 } from "@frockbot/kernel-contracts";
import { decodeBotIdV1, isRpcIdentifier } from "@frockbot/configuration-core";
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

/**
 * The plain-JSON value one Durable Object's answer really is.
 *
 * A cross-object RPC answer arrives as a live stub carrying `Symbol.dispose`
 * and whatever else the runtime attached to it, and an exact-keys decoder is
 * right to refuse that. Snapshotting first is what turns the answer into the
 * DTO it claims to be, before anything decodes it.
 */
export function rpcJsonSnapshotV1<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("RPC response is not a JSON value");
    }
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error("RPC response is not valid JSON", { cause: error });
  }
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
  if (!isRpcIdentifier(value)) {
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

export function rpcInteger(bounds: {
  minimum: number;
  maximum: number;
}): RpcValueDecoder {
  return (value, label) => {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < bounds.minimum ||
      (value as number) > bounds.maximum
    ) {
      throw new Error(`${label} must be a bounded integer`);
    }
    return value;
  };
}

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

export function rpcPattern(pattern: RegExp, maximum = 256): RpcValueDecoder {
  return (value, label) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum ||
      !pattern.test(value)
    ) {
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

/**
 * Carries an inbound value through the envelope decoder unchanged, for a
 * caller that decodes it against a richer contract of its own — a Workspace
 * root, a generation record — immediately afterwards. It is never a way to
 * skip decoding: the value is still refused before it reaches durable state.
 */
export const rpcDecodedValue: RpcValueDecoder = (value, label) => {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

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
    skills?: SkillRefV1[];
    /** The lane this command asks for. Only `user` crosses this seam. */
    lane?: "user";
    /** Explicit intent to replace the Turn the client observed running. */
    supersedes?: { runId?: string };
  };
}

/**
 * The optional members of a Turn command, shared by every door a Turn command
 * crosses — the User application's `run` and the Bot Durable Object's — so a
 * field one door accepts is never one another door rejects.
 *
 * Invoked Skills cross the RPC as refs and are decoded here, at the door,
 * exactly like every other inbound value. Only the User's own composer
 * supersedes. A Turn type is still never carried here, so the lane the HTTP
 * path may name is exactly the one an absent lane would already have meant.
 */
export const rpcBotTurnCommandOptionalsV1: Readonly<
  Record<string, RpcValueDecoder>
> = {
  skills: (value, label) => decodeSkillRefsV1(value, label),
  lane: (value, label) => {
    if (value !== "user") throw new Error(`${label} is invalid`);
    return "user" as const;
  },
  supersedes: (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} is invalid`);
    }
    const keys = Reflect.ownKeys(value);
    const candidate = value as Record<string, unknown>;
    // The intent is the whole of the command; the run id is provenance the
    // composer supplies only when it has observed one. A composer that sent
    // while it believed nothing was running still means "replace whatever you
    // are doing with this", so an empty object is valid.
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "runId")) {
      throw new Error(`${label} is invalid`);
    }
    if (candidate.runId === undefined) return {};
    if (typeof candidate.runId !== "string") {
      throw new Error(`${label} is invalid`);
    }
    return { runId: decodeRunIdV1(candidate.runId) };
  },
};

export function decodeBotRunRpcV1(input: unknown): DecodedBotRunRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject(
      {
        runId: rpcString(128),
        sessionId: rpcString(257),
        acceptedAt: rpcString(64),
        text: rpcString(32_000),
      },
      rpcBotTurnCommandOptionalsV1,
    ),
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
