export const VOICE_GEMINI_MODEL_V1 = "gemini-3.1-flash-live-preview";
export const VOICE_INPUT_SAMPLE_RATE_V1 = 16_000;
export const VOICE_OUTPUT_SAMPLE_RATE_V1 = 24_000;
export const VOICE_IDLE_TIMEOUT_MS_V1 = 2 * 60_000;

export function voiceSystemInstructionV1(): string {
  return [
    "You are the User's FrockBot voice assistant.",
    "You can read their Bots, each Bot's recent activity, and durable User and Bot memory using the tools provided.",
    "You can use ask_bot to ask one active Bot a question on the User's behalf. It returns immediately: say the returned message naturally and never wait for the Bot in the current turn.",
    "You cannot change Bot configuration or write memory. Say that plainly when asked.",
    "Keep spoken answers brief and natural. Use tools when facts may have changed; never invent activity or memory.",
    "At the start, check pending_answers. If any answers are waiting, speak those before a greeting or anything else.",
  ].join("\n");
}

export const VOICE_KICKOFF_TEXT_V1 =
  "Check pending_answers now. Speak any waiting answers first; otherwise greet me in one short sentence and listen.";
