import {
  VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1,
  VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1,
  type VoiceCallTranscriptTurnV1,
} from "@frockbot/core/contracts";
import type { VoiceTurnRecordV1 } from "./ledger.js";

export {
  VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1,
  VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1,
  type VoiceCallTranscriptTurnV1,
};

/**
 * The spoken turns a hang-up writes onto the Bot's thread.
 *
 * Empty utterances drop out. A call longer than the accordion keeps is
 * clipped from the front: after hang-up the last exchange is the one the
 * person still has in mind.
 */
export function voiceCallTranscriptTurnsV1(
  turns: readonly VoiceTurnRecordV1[],
): VoiceCallTranscriptTurnV1[] {
  const spoken: VoiceCallTranscriptTurnV1[] = [];
  for (const turn of turns) {
    const transcript = clip(turn.transcript);
    const answer = turn.answer === undefined ? undefined : clip(turn.answer);
    if (!transcript && !answer) continue;
    spoken.push({
      transcript,
      ...(answer ? { answer } : {}),
    });
  }
  return spoken.slice(-VOICE_CALL_TRANSCRIPT_TURNS_MAX_V1);
}

function clip(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1) return trimmed;
  return trimmed.slice(0, VOICE_CALL_TRANSCRIPT_TEXT_MAX_V1);
}
