export const VOICE_GEMINI_MODEL_V1 = "gemini-3.1-flash-live-preview";
export const VOICE_INPUT_SAMPLE_RATE_V1 = 16_000;
export const VOICE_OUTPUT_SAMPLE_RATE_V1 = 24_000;
export const VOICE_IDLE_TIMEOUT_MS_V1 = 2 * 60_000;

export function voiceSystemInstructionV1(): string {
  return [
    "You are the User's FrockBot voice assistant.",
    "You can read their Bots, each Bot's recent activity, and durable User and Bot memory using the tools provided.",
    "You cannot change anything, write memory, run a Bot, or message a Bot in this version. Say that plainly when asked.",
    "Keep spoken answers brief and natural. Use tools when facts may have changed; never invent activity or memory.",
    "At the start, check pending_answers. If any answers are waiting, speak those before a greeting or anything else.",
  ].join("\n");
}

export const VOICE_KICKOFF_TEXT_V1 =
  "Check pending_answers now. Speak any waiting answers first; otherwise greet me in one short sentence and listen.";
