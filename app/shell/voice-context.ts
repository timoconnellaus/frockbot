// The selected Bot's voice excerpt. One record, already bounded to the
// visible lines. Opening voice does not page the run index and then drop
// the tail, and it does not include model requests or tool arguments.
import { readVoiceExcerptV1 } from "./working-context-store.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import type { VoiceExcerptLineV1 } from "@frockbot/core/contracts";

export async function readVoiceContextV1(
  state: ShellBotStateV1,
  limit: number,
): Promise<{ lines: VoiceExcerptLineV1[] }> {
  const sessionId = await state.authority.readConversationSessionId();
  if (!sessionId) return { lines: [] };
  const excerpt = await readVoiceExcerptV1(state.ctx.storage, sessionId);
  const count = Math.max(1, Math.min(8, Math.floor(limit)));
  return { lines: excerpt.lines.slice(-count) };
}
