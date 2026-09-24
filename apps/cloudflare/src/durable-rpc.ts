import {
  decodeSkillRefsV1,
  decodeUploadRefsV1,
  type SkillRefV1,
  type UploadRefV1,
} from "@frockbot/core/contracts";
import { decodeBotIdV1, isRpcIdentifier } from "@frockbot/core/configuration";
import { decodeRunIdV1 } from "@frockbot/app/shell/backend-contracts";
import {
  decodeStoredRunCauseV1,
  type StoredRunCauseV1,
  type StoredRunEmailOriginV1,
  type StoredRunGroupOriginV1,
} from "@frockbot/core/durable";
import {
  VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1,
  VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1,
  type VoiceCallTranscriptTurnV1,
} from "@frockbot/core/contracts";

export { rpcJsonSnapshotV1 } from "@frockbot/app/durable-rpc";

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
  if (!isRpcIdentifier(value)) {
    throw new Error(`${label} must be an identifier`);
  }
  return value;
};

/** An http(s) origin and nothing else: no path, query or credentials. */
export const rpcOrigin: RpcValueDecoder = (value, label) => {
  if (typeof value === "string" && value.length <= 256) {
    try {
      const url = new URL(value);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === value
      ) {
        return value;
      }
    } catch {
      // Falls through to the refusal below.
    }
  }
  throw new Error(`${label} must be an http(s) origin`);
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

/** A Plugin id, or `null` to close the conversation panel. */
export const rpcPluginIdOrNull: RpcValueDecoder = (value, label) => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} must be a plugin id or null`);
  }
  return value;
};

export const rpcBoolean: RpcValueDecoder = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
};

export function rpcArray(
  item: RpcValueDecoder,
  maximum: number,
): RpcValueDecoder {
  return (value, label) => {
    if (!Array.isArray(value) || value.length > maximum) {
      throw new Error(`${label} must be a bounded array`);
    }
    return value.map((entry, index) => item(entry, `${label}[${index}]`));
  };
}

export function rpcText(maximum: number): RpcValueDecoder {
  return (value, label) => {
    if (typeof value !== "string" || value.length > maximum) {
      throw new Error(`${label} must be a bounded string`);
    }
    return value;
  };
}

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
    /** Refs only: the Bot resolves each against its own uploads. */
    attachments?: UploadRefV1[];
    retryOf?: string;
  };
}

/**
 * A Turn command as it crosses an RPC door: its files are refs, and only the
 * Bot Durable Object that holds the uploads turns them into attachments.
 */
export type BotTurnCommandRequestV1<Command extends object> = Omit<
  Command,
  "attachments"
> & { attachments?: readonly UploadRefV1[] };

/**
 * A Turn command's text. Empty is allowed here and nowhere else: a message may
 * be files alone, which {@link requireTurnCommandContentV1} checks once the
 * whole command is decoded.
 */
export function rpcTurnText(maximum: number): RpcValueDecoder {
  return (value, label) => {
    if (typeof value !== "string" || value.length > maximum) {
      throw new Error(`${label} must be a bounded string`);
    }
    return value;
  };
}

/** A command carries words, files, or both — never neither. */
export function requireTurnCommandContentV1(command: {
  text: string;
  attachments?: readonly unknown[];
}): void {
  if (command.text.trim().length === 0 && !command.attachments?.length) {
    throw new Error("RPC request.command.text is required");
  }
}

/**
 * The optional members of a Turn command, shared by every door a Turn command
 * crosses — the User application's `run` and the Bot Durable Object's — so a
 * field one door accepts is never one another door rejects.
 *
 * Invoked Skills cross the RPC as refs and are decoded here, at the door,
 * exactly like every other inbound value. Neither a Turn type nor a lane is
 * carried here: only the composer reaches this door, and an absent lane is
 * already the person's own.
 */
export const rpcBotTurnCommandOptionalsV1: Readonly<
  Record<string, RpcValueDecoder>
> = {
  skills: (value, label) => decodeSkillRefsV1(value, label),
  attachments: (value, label) => decodeUploadRefsV1(value, label),
  retryOf: (value) => decodeRunIdV1(value),
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
        text: rpcTurnText(32_000),
      },
      rpcBotTurnCommandOptionalsV1,
    ),
  });
  const command = request.command as DecodedBotRunRpcV1["command"];
  requireTurnCommandContentV1(command);
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

export interface DecodedBotAgentRunRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    sessionId: string;
    acceptedAt: string;
    text: string;
    source: {
      kind: "bot";
      fromBotId: string;
      fromBotName: string;
      messageId: string;
      cause?: StoredRunCauseV1;
    };
  };
}

/** What started the asking Turn, decoded as the run record decodes it. */
const rpcRunCause: RpcValueDecoder = (value, label) => {
  try {
    return decodeStoredRunCauseV1(value, label);
  } catch {
    throw new Error(`${label} is invalid`);
  }
};

export interface DecodedBotVoiceRunRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    sessionId: string;
    acceptedAt: string;
    text: string;
    source: {
      kind: "voice";
      callId: string;
      voiceTurnId: string;
      requestId: string;
    };
  };
}

/**
 * Internal-only voice admission. Its own door rather than a variant of the
 * agent one: the return address a voice request carries is not a Bot id, and a
 * door that accepted either could be handed a Bot's name where a call belongs.
 * The HTTP Turn decoder cannot name this shape at all.
 */
export function decodeBotVoiceRunRpcV1(
  input: unknown,
): DecodedBotVoiceRunRpcV1 {
  const source = rpcObject({
    kind: rpcPattern(/^voice$/, 5),
    callId: rpcString(128),
    voiceTurnId: rpcString(256),
    requestId: rpcString(128),
  });
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      runId: rpcString(128),
      sessionId: rpcString(257),
      acceptedAt: rpcString(64),
      text: rpcString(32_000),
      source,
    }),
  });
  const command = request.command as DecodedBotVoiceRunRpcV1["command"];
  command.runId = decodeRunIdV1(command.runId);
  // The request the answer goes back to is the Turn that answers it. A door
  // that let the two differ would let one admission address another's caller.
  if (command.source.requestId !== command.runId) {
    throw new Error("voice RPC request.command.source.requestId is invalid");
  }
  if (!Number.isFinite(Date.parse(command.acceptedAt))) {
    throw new Error("voice RPC request.command.acceptedAt is invalid");
  }
  if (new TextEncoder().encode(command.text).byteLength > 32_000) {
    throw new Error("voice RPC request.command.text is invalid");
  }
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}

export interface DecodedVoiceChatResultRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    body: string;
    ordinal: number;
  };
}

/**
 * A settled voice request written into the Bot's thread after hang-up.
 * Internal-only: the voice object is the only caller.
 */
export function decodeVoiceChatResultRpcV1(
  input: unknown,
): DecodedVoiceChatResultRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      runId: rpcString(128),
      body: rpcString(4_000),
      ordinal: rpcInteger({ minimum: 0, maximum: 64 }),
    }),
  });
  const command = request.command as DecodedVoiceChatResultRpcV1["command"];
  command.runId = decodeRunIdV1(command.runId);
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}

export interface DecodedVoiceCallTranscriptRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    callId: string;
    startedAt: string;
    endedAt: string;
    turns: VoiceCallTranscriptTurnV1[];
  };
}

function rpcInstant(): RpcValueDecoder {
  return (value, label) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new Error(`${label} is invalid`);
    }
    return value;
  };
}

/**
 * Spoken turns of one ended call, written onto the Bot's thread.
 * Internal-only: the voice object is the only caller.
 */
export function decodeVoiceCallTranscriptRpcV1(
  input: unknown,
): DecodedVoiceCallTranscriptRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      callId: rpcString(128),
      startedAt: rpcInstant(),
      endedAt: rpcInstant(),
      turns: rpcArray(
        rpcObject(
          { transcript: rpcText(VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1) },
          { answer: rpcText(VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1) },
        ),
        VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1,
      ),
    }),
  });
  const command = request.command as DecodedVoiceCallTranscriptRpcV1["command"];
  if (command.turns.length === 0) {
    throw new Error("RPC request.command.turns is invalid");
  }
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}

/** Internal-only agent admission; the HTTP Turn decoder cannot name it. */
export function decodeBotAgentRunRpcV1(
  input: unknown,
): DecodedBotAgentRunRpcV1 {
  const source = rpcObject(
    {
      kind: rpcPattern(/^bot$/, 3),
      fromBotId: rpcBotId,
      fromBotName: rpcString(100),
      messageId: rpcString(256),
    },
    { cause: rpcRunCause },
  );
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      runId: rpcString(128),
      sessionId: rpcString(257),
      acceptedAt: rpcString(64),
      text: rpcString(32_000),
      source,
    }),
  });
  const command = request.command as DecodedBotAgentRunRpcV1["command"];
  command.runId = decodeRunIdV1(command.runId);
  if (!Number.isFinite(Date.parse(command.acceptedAt))) {
    throw new Error("agent RPC request.command.acceptedAt is invalid");
  }
  if (new TextEncoder().encode(command.text).byteLength > 32_000) {
    throw new Error("agent RPC request.command.text is invalid");
  }
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}

export interface DecodedBotEmailTurnRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    sessionId: string;
    acceptedAt: string;
    text: string;
    /** Refs only: the Bot resolves each against its own uploads. */
    attachments?: UploadRefV1[];
    origin: StoredRunEmailOriginV1;
  };
}

/**
 * Internal-only email admission: the person, writing from one of their
 * confirmed mailboxes, into this Bot's own conversation. Its own door so that
 * the one caller able to name an `email` origin is the Worker's `email()`
 * handler, after the User object accepted the sender; the HTTP Turn decoder
 * cannot name it.
 */
export function decodeBotEmailTurnRpcV1(
  input: unknown,
): DecodedBotEmailTurnRpcV1 {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject(
      {
        runId: rpcPattern(/^em-[0-9a-f]{64}$/, 67),
        sessionId: rpcString(257),
        acceptedAt: rpcString(64),
        text: rpcTurnText(32_000),
        origin: rpcObject({
          kind: rpcPattern(/^email$/, 5),
          messageId: rpcPattern(/^[\x21-\x3b\x3d\x3f-\x7e]{1,250}$/, 250),
        }),
      },
      {
        attachments: (value, label) => decodeUploadRefsV1(value, label),
      },
    ),
  });
  const userId = request.userId as string;
  const botId = request.botId as string;
  const command = request.command as DecodedBotEmailTurnRpcV1["command"];
  requireTurnCommandContentV1(command);
  if (command.sessionId !== `${userId}:${botId}`) {
    throw new Error("email RPC request.command.sessionId is invalid");
  }
  if (!Number.isFinite(Date.parse(command.acceptedAt))) {
    throw new Error("email RPC request.command.acceptedAt is invalid");
  }
  if (new TextEncoder().encode(command.text).byteLength > 32_000) {
    throw new Error("email RPC request.command.text is invalid");
  }
  return { schemaVersion: 1, userId, botId, command };
}

export interface DecodedBotGroupTurnRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: {
    runId: string;
    sessionId: string;
    acceptedAt: string;
    text: string;
    origin: StoredRunGroupOriginV1;
  };
}

/**
 * Internal-only group admission: a Group Chat's object asking one of its
 * members for a Turn. Its own door, like voice's: the return address is a
 * group, and the Session is that group's, never the member's one-to-one chat.
 */
export function decodeBotGroupTurnRpcV1(
  input: unknown,
): DecodedBotGroupTurnRpcV1 {
  const origin = rpcObject({
    kind: rpcPattern(/^group$/, 5),
    groupId: rpcPattern(/^g-[0-9a-f]{20}$/, 22),
    groupName: rpcText(1_000),
    members: rpcArray(rpcObject({ botId: rpcBotId, name: rpcText(100) }), 8),
    throughSeq: rpcInteger({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    reason: rpcEnum(["mention", "continue", "retry", "jev"] as const),
  });
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcObject({
      runId: rpcString(128),
      sessionId: rpcString(257),
      acceptedAt: rpcString(64),
      text: rpcString(32_000),
      origin,
    }),
  });
  const command = request.command as DecodedBotGroupTurnRpcV1["command"];
  command.runId = decodeRunIdV1(command.runId);
  if (command.sessionId !== `group:${command.origin.groupId}`) {
    throw new Error("group RPC request.command.sessionId is invalid");
  }
  if (!Number.isFinite(Date.parse(command.acceptedAt))) {
    throw new Error("group RPC request.command.acceptedAt is invalid");
  }
  if (command.origin.members.length === 0) {
    throw new Error("group RPC request.command.origin.members is invalid");
  }
  return {
    schemaVersion: 1,
    userId: request.userId as string,
    botId: request.botId as string,
    command,
  };
}
