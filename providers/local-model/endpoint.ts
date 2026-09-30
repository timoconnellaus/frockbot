// Where a local model lives: a Mac the person paired, and an OpenAI-compatible
// server on that Mac's loopback. Both are Connection settings; neither is a
// secret, and there is no credential at all.

import { sha256HexV1 } from "@frockbot/core/crypto";
import { decodeLocalModelUrlV1 } from "@frockbot/core/machine-protocol/relay";

export const LOCAL_MODEL_PACKAGE_ID = "provider-local";
export const LOCAL_MODEL_PROVIDER = "local";
export const LOCAL_MODEL_CONNECTION_TYPE_ID = "local-model";
export const LOCAL_MODEL_MACHINE_SETTING = "machine-id";
export const LOCAL_MODEL_ENDPOINT_SETTING = "endpoint";

/** The servers people run, at the address each listens on by default. */
export const LOCAL_MODEL_SERVERS_V1 = [
  { id: "ollama", name: "Ollama", endpoint: "http://localhost:11434/v1" },
  { id: "lm-studio", name: "LM Studio", endpoint: "http://localhost:1234/v1" },
  { id: "mesh-llm", name: "mesh-llm", endpoint: "http://localhost:9337/v1" },
] as const;

/** How long a model server has to begin answering a chat: loading a model is slow. */
export const LOCAL_MODEL_CHAT_FIRST_BYTE_MS = 120_000;
/** How long it has to list its models. */
export const LOCAL_MODEL_LIST_FIRST_BYTE_MS = 15_000;

/**
 * A person's endpoint, normalised, or the sentence that says why it is not
 * one. Only a loopback address is ever a local model.
 */
export function decodeLocalModelEndpointV1(value: unknown): string {
  try {
    return decodeLocalModelUrlV1(value, "The endpoint");
  } catch (error) {
    throw new Error(
      error instanceof Error && /must be on this computer/.test(error.message)
        ? "A local model's endpoint must be on your Mac: use localhost, 127.0.0.1 or [::1], like http://localhost:11434/v1."
        : "Enter the server's address, like http://localhost:11434/v1.",
    );
  }
}

/** The two things a relay is ever asked to do. */
export type LocalModelOperationV1 = "models" | "chat";

/** The one URL an operation reaches, under the Connection's endpoint. */
export function localModelUrlV1(
  endpoint: string,
  operation: LocalModelOperationV1,
): string {
  const root = decodeLocalModelEndpointV1(endpoint);
  return `${root}/${operation === "models" ? "models" : "chat/completions"}`;
}

const RELAY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,180}$/;

/**
 * The relay id a chat request travels under: its durable request id, which is
 * the model call's idempotency key, or that id's digest when it would not fit
 * the wire's identifier rule.
 */
export async function localModelChatRelayIdV1(
  requestId: string,
): Promise<string> {
  const id = `chat:${requestId}`;
  return RELAY_ID.test(id) ? id : `chat:${await sha256HexV1(requestId)}`;
}
