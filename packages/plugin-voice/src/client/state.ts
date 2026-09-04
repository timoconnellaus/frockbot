import type { VoiceAssistantLiveStateV1 } from "@frockbot/protocol";
import type {
  VoiceSessionRecordV1,
  VoiceToolCallEntryV1,
  VoiceTranscriptEntryV1,
} from "../shared.js";
import type { InjectionKey, Ref } from "vue";

export interface VoiceClientStateV1 {
  enabled: boolean;
  status: VoiceAssistantLiveStateV1;
  level: number;
  quotaRemainingSeconds: number;
  quotaLimitSeconds: number;
  session?: Pick<VoiceSessionRecordV1, "sessionId" | "startedAt">;
  transcript: VoiceTranscriptEntryV1[];
  tools: VoiceToolCallEntryV1[];
  message?: string;
  refresh(): Promise<void>;
  toggle(): Promise<void>;
  open(): void;
}

export const voiceClientStateKey: InjectionKey<Ref<VoiceClientStateV1>> =
  Symbol("frockbot.voice.client-state");
