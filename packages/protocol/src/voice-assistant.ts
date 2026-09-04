/** Browser ↔ VoiceSession protocol for the app-wide assistant. */
export const VOICE_ASSISTANT_VERSION_V1 = 1 as const;
export const VOICE_ASSISTANT_INPUT_SAMPLE_RATE_V1 = 16_000;
export const VOICE_ASSISTANT_OUTPUT_SAMPLE_RATE_V1 = 24_000;

export type VoiceAssistantLiveStateV1 =
  "connecting" | "listening" | "speaking" | "offline";

/** Audio is a binary PCM16LE frame; these are the browser's text controls. */
export type VoiceAssistantClientFrameV1 = {
  schemaVersion: 1;
  type: "stop";
};

export type VoiceAssistantServerFrameV1 =
  | {
      schemaVersion: 1;
      type: "ready";
      sessionId: string;
      quotaRemainingSeconds: number;
    }
  | {
      schemaVersion: 1;
      type: "state";
      state: "listening" | "speaking";
    }
  | {
      schemaVersion: 1;
      type: "transcript";
      id: string;
      speaker: "user" | "assistant";
      text: string;
      at: string;
    }
  | {
      schemaVersion: 1;
      type: "tool";
      id: string;
      name: string;
      label: string;
      at: string;
    }
  | { schemaVersion: 1; type: "interrupted" }
  | {
      schemaVersion: 1;
      type: "offline";
      reason: "stopped" | "idle" | "quota" | "error" | "replaced";
      message: string;
    };

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("voice assistant frame must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) {
    throw new Error("voice assistant frame version is unsupported");
  }
  return value;
}

function text(
  value: Record<string, unknown>,
  field: string,
  max = 8_192,
): string {
  const found = value[field];
  if (typeof found !== "string" || !found || found.length > max) {
    throw new Error(`voice assistant frame.${field} is invalid`);
  }
  return found;
}

export function decodeVoiceAssistantClientFrameV1(
  input: unknown,
): VoiceAssistantClientFrameV1 {
  const value = object(input);
  if (value.type !== "stop") {
    throw new Error("voice assistant client frame type is invalid");
  }
  return { schemaVersion: 1, type: "stop" };
}

export function decodeVoiceAssistantServerFrameV1(
  input: unknown,
): VoiceAssistantServerFrameV1 {
  const value = object(input);
  switch (value.type) {
    case "ready": {
      if (
        !Number.isSafeInteger(value.quotaRemainingSeconds) ||
        (value.quotaRemainingSeconds as number) < 0
      ) {
        throw new Error("voice assistant frame quota is invalid");
      }
      return {
        schemaVersion: 1,
        type: "ready",
        sessionId: text(value, "sessionId", 128),
        quotaRemainingSeconds: value.quotaRemainingSeconds as number,
      };
    }
    case "state":
      if (value.state !== "listening" && value.state !== "speaking") {
        throw new Error("voice assistant frame state is invalid");
      }
      return { schemaVersion: 1, type: "state", state: value.state };
    case "transcript":
      if (value.speaker !== "user" && value.speaker !== "assistant") {
        throw new Error("voice assistant frame speaker is invalid");
      }
      return {
        schemaVersion: 1,
        type: "transcript",
        id: text(value, "id", 128),
        speaker: value.speaker,
        text: text(value, "text"),
        at: text(value, "at", 64),
      };
    case "tool":
      return {
        schemaVersion: 1,
        type: "tool",
        id: text(value, "id", 128),
        name: text(value, "name", 128),
        label: text(value, "label", 160),
        at: text(value, "at", 64),
      };
    case "interrupted":
      return { schemaVersion: 1, type: "interrupted" };
    case "offline": {
      const reasons = ["stopped", "idle", "quota", "error", "replaced"];
      if (!reasons.includes(String(value.reason))) {
        throw new Error("voice assistant frame reason is invalid");
      }
      return {
        schemaVersion: 1,
        type: "offline",
        reason: value.reason as Extract<
          VoiceAssistantServerFrameV1,
          { type: "offline" }
        >["reason"],
        message: text(value, "message", 1_024),
      };
    }
    default:
      throw new Error("voice assistant server frame type is invalid");
  }
}

export function parseVoiceAssistantServerFrameV1(
  input: string,
): VoiceAssistantServerFrameV1 {
  return decodeVoiceAssistantServerFrameV1(JSON.parse(input) as unknown);
}
