import {
  VOICE_FUNCTION_DECLARATIONS_V1,
  VOICE_GEMINI_MODEL_V1,
  VOICE_KICKOFF_TEXT_V1,
  voiceSystemInstructionV1,
  type VoicePendingAnswerV1,
} from "@frockbot/plugin-voice";
import type { VoiceSessionEnvV1 } from "./voice-upstream.js";

const GEMINI_LIVE_ENDPOINT_V1 =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export type VoiceAssistantUpstreamTargetV1 =
  | {
      path: "override" | "gemini" | "gateway";
      url: string;
      headers: Record<string, string>;
    }
  | { path: "unconfigured"; message: string };

export function voiceAssistantUpstreamTargetV1(
  env: VoiceSessionEnvV1,
): VoiceAssistantUpstreamTargetV1 {
  if (env.VOICE_ASSISTANT_UPSTREAM_URL) {
    return {
      path: "override",
      url: env.VOICE_ASSISTANT_UPSTREAM_URL,
      headers: {},
    };
  }
  if (env.GEMINI_API_KEY) {
    return {
      path: "gemini",
      url: `${GEMINI_LIVE_ENDPOINT_V1}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      headers: {},
    };
  }
  const token = env.FROCK_AI_GATEWAY_TOKEN ?? env.FLOCK_AI_GATEWAY_TOKEN;
  const accountId = env.FROCK_AI_ACCOUNT_ID ?? env.FLOCK_AI_ACCOUNT_ID;
  const gatewayId =
    env.FROCK_AI_GATEWAY_ID ?? env.FLOCK_AI_GATEWAY_ID ?? "flock";
  if (token && accountId) {
    return {
      path: "gateway",
      // Cloudflare's realtime documentation names this route `/google`.
      // `/google-ai-studio` is the provider-native REST route, not the
      // documented WebSocket route.
      url: `wss://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/google`,
      headers: { "cf-aig-authorization": `Bearer ${token}` },
    };
  }
  return {
    path: "unconfigured",
    message:
      "Voice isn't set up on this deployment yet. You can keep using text.",
  };
}

export function voiceAssistantSetupV1(
  resumptionHandle?: string,
): Record<string, unknown> {
  return {
    setup: {
      model: `models/${VOICE_GEMINI_MODEL_V1}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      systemInstruction: {
        parts: [{ text: voiceSystemInstructionV1() }],
      },
      tools: [{ functionDeclarations: VOICE_FUNCTION_DECLARATIONS_V1 }],
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    },
  };
}

function answerBriefingTextV1(
  answers: readonly VoicePendingAnswerV1[],
): string {
  if (answers.length === 0) return VOICE_KICKOFF_TEXT_V1;
  return [
    "Speak these waiting Bot answers now, naming each Bot. Do not call a tool and do not omit any answer:",
    ...answers.map(
      (answer, index) =>
        `${index + 1}. ${answer.botName} answered ${JSON.stringify(answer.question)}: ${answer.answer}`,
    ),
  ].join("\n");
}

export function voiceAssistantKickoffV1(
  answers: readonly VoicePendingAnswerV1[] = [],
): Record<string, unknown> {
  return { realtimeInput: { text: answerBriefingTextV1(answers) } };
}

export function voiceAssistantAnswerV1(
  answer: VoicePendingAnswerV1,
): Record<string, unknown> {
  return {
    realtimeInput: {
      text: `Speak this Bot answer now, naming the Bot: ${answer.botName} answered ${JSON.stringify(answer.question)}: ${answer.answer}`,
    },
  };
}

export function voiceAssistantAudioInputV1(
  data: string,
): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: { data, mimeType: "audio/pcm;rate=16000" },
    },
  };
}

export interface GeminiLiveFunctionCallV1 {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface VoiceAssistantUpstreamFrameV1 {
  setupComplete: boolean;
  inputTranscript?: string;
  outputTranscript?: string;
  audio: string[];
  interrupted: boolean;
  turnComplete: boolean;
  resumptionHandle?: string;
  goAwayMs?: number;
  functionCalls: GeminiLiveFunctionCallV1[];
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseVoiceAssistantUpstreamFrameV1(
  raw: string,
): VoiceAssistantUpstreamFrameV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const value = record(parsed);
  if (!value) return undefined;
  const serverContent = record(value.serverContent);
  const input = record(serverContent?.inputTranscription);
  const output = record(serverContent?.outputTranscription);
  const modelTurn = record(serverContent?.modelTurn);
  const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
  const audio = parts.flatMap((part) => {
    const inlineData = record(record(part)?.inlineData);
    return typeof inlineData?.data === "string" && inlineData.data
      ? [inlineData.data]
      : [];
  });
  const update = record(value.sessionResumptionUpdate);
  const goAway = record(value.goAway);
  const toolCall = record(value.toolCall);
  const calls = Array.isArray(toolCall?.functionCalls)
    ? toolCall.functionCalls.flatMap((call, index) => {
        const found = record(call);
        if (!found || typeof found.name !== "string" || !found.name) return [];
        return [
          {
            id:
              typeof found.id === "string" && found.id
                ? found.id.slice(0, 128)
                : `call-${index}`,
            name: found.name.slice(0, 128),
            args: record(found.args) ?? {},
          },
        ];
      })
    : [];
  const error = record(value.error);
  const timeLeft = typeof goAway?.timeLeft === "string" ? goAway.timeLeft : "";
  const seconds = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(timeLeft)?.[1];
  return {
    setupComplete: value.setupComplete !== undefined,
    ...(typeof input?.text === "string" && input.text
      ? { inputTranscript: input.text.slice(0, 8_192) }
      : {}),
    ...(typeof output?.text === "string" && output.text
      ? { outputTranscript: output.text.slice(0, 8_192) }
      : {}),
    audio,
    interrupted: serverContent?.interrupted === true,
    turnComplete: serverContent?.turnComplete === true,
    ...(update?.resumable === true &&
    typeof update.newHandle === "string" &&
    update.newHandle
      ? { resumptionHandle: update.newHandle.slice(0, 16_384) }
      : {}),
    ...(seconds ? { goAwayMs: Math.max(0, Number(seconds) * 1_000) } : {}),
    functionCalls: calls,
    ...(typeof error?.message === "string"
      ? { error: error.message.slice(0, 1_024) }
      : {}),
  };
}

export function voiceAssistantToolResponseV1(input: {
  id: string;
  name: string;
  result: unknown;
}): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: input.id,
          name: input.name,
          response: { result: input.result },
        },
      ],
    },
  };
}

export const VOICE_ASSISTANT_UPSTREAM_ERROR_V1 =
  "Voice went offline because the speech service stopped responding. Try again.";
