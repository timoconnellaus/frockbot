import {
  APIError,
  type JsonValue,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import {
  bytesToBase64V1,
  type ComputerEgressJevV1,
  type ComputerEgressResponseV1,
} from "@frockbot/computer/egress";
import type { JevMeterV1 } from "../billing/jev.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// Jev for the Computer's terminal, reached at `jev.internal`. The request is a
// System One body the command wrote; the platform's key answers it, pinned to
// the platform's model, and the account pays for the input tokens Jev counts.
// The key never reaches the Computer.

/** Largest body a command may send: a page's worth of state and its questions. */
export const JEV_EGRESS_BODY_MAX_BYTES_V1 = 65_536;

/** Most questions one request may ask. */
export const JEV_EGRESS_QUESTIONS_MAX_V1 = 32;

/**
 * Jev's own framing of a request costs tokens the body does not show, so the
 * hold covers it on top of the body's bytes.
 */
const JEV_EGRESS_FRAMING_TOKENS_V1 = 1_000;

/** A decision is fast or it is a fault. */
const JEV_EGRESS_TIMEOUT_MS_V1 = 10_000;

function answer(status: number, body: unknown): ComputerEgressResponseV1 {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyBase64: bytesToBase64V1(new TextEncoder().encode(JSON.stringify(body))),
  };
}

const message = (status: number, text: string) =>
  answer(status, { message: text });

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createJevEgressV1(config: {
  client: TypeSafeClient;
  /** Absent where billing is off: the request is answered and charged nothing. */
  meter?: JevMeterV1;
  botId: string;
  sessionId: string;
}): ComputerEgressJevV1 {
  return async ({ body, effectId, signal }) => {
    if (body.byteLength > JEV_EGRESS_BODY_MAX_BYTES_V1) {
      return message(
        413,
        `A Jev request is at most ${JEV_EGRESS_BODY_MAX_BYTES_V1} bytes; send less state.`,
      );
    }
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder().decode(body));
    } catch {
      request = undefined;
    }
    if (
      !isRecord(request) ||
      !isRecord(request.state) ||
      !isRecord(request.questions)
    ) {
      return message(
        400,
        'A Jev request is a JSON object with "state" and "questions" objects.',
      );
    }
    const count = Object.keys(request.questions).length;
    if (count === 0 || count > JEV_EGRESS_QUESTIONS_MAX_V1) {
      return message(
        400,
        `A Jev request asks between 1 and ${JEV_EGRESS_QUESTIONS_MAX_V1} questions.`,
      );
    }
    let charge;
    try {
      charge = await config.meter?.reserve({
        effectId,
        botId: config.botId,
        sessionId: config.sessionId,
        maximumInputTokens: body.byteLength + JEV_EGRESS_FRAMING_TOKENS_V1,
      });
    } catch (error) {
      return message(
        402,
        error instanceof Error ? error.message : "The account cannot pay.",
      );
    }
    try {
      const result = await config.client.systemOne(
        {
          state: request.state,
          questions: request.questions as never,
          model: RESPONSE_REVIEW_MODEL_V1,
        },
        {
          retry: { maxRetries: 0 },
          timeout: JEV_EGRESS_TIMEOUT_MS_V1,
          ...(signal ? { signal } : {}),
        },
      );
      await charge?.charge(result.usage.input_tokens);
      return answer(200, {
        model: result.model,
        answers: result.answers,
        usage: result.usage,
      });
    } catch (error) {
      // A refusal Jev answered spent nothing. Anything else — a timeout, a
      // dropped connection — may have been counted, so the hold stays for
      // reconciliation rather than being released or charged on a guess.
      if (error instanceof APIError && error.status < 500) {
        await charge?.release();
        return message(
          error.status === 401 || error.status === 403 ? 502 : 400,
          `Jev refused the request: ${error.message}`.slice(0, 500),
        );
      }
      return message(
        502,
        "Jev's answer could not be confirmed. The request may still be charged; try again.",
      );
    }
  };
}
