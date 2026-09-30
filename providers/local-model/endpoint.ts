// Where a local model lives: a Mac the person paired, and an OpenAI-compatible
// server on that Mac's loopback. Both are Connection settings; neither is a
// secret, and there is no credential at all.

import { sha256HexV1 } from "@frockbot/core/crypto";
import {
  decodeLocalModelUrlV1,
  isMachineRelayIdV1,
} from "@frockbot/core/machine-protocol";

export const LOCAL_MODEL_PACKAGE_ID = "provider-local";
export const LOCAL_MODEL_PROVIDER = "local";
export const LOCAL_MODEL_CONNECTION_TYPE_ID = "local-model";
export const LOCAL_MODEL_MACHINE_SETTING = "machine-id";
export const LOCAL_MODEL_ENDPOINT_SETTING = "endpoint";

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

/** The one URL an operation reaches, under a Connection's decoded endpoint. */
export function localModelUrlV1(
  endpoint: string,
  operation: "models" | "chat",
): string {
  return `${endpoint}/${operation === "models" ? "models" : "chat/completions"}`;
}

/**
 * The relay id a chat request travels under: its durable request id, which is
 * the model call's idempotency key, or that id's digest when it would not fit
 * the wire's identifier rule.
 */
export async function localModelChatRelayIdV1(
  requestId: string,
): Promise<string> {
  const id = `chat:${requestId}`;
  return isMachineRelayIdV1(id) ? id : `chat:${await sha256HexV1(requestId)}`;
}
