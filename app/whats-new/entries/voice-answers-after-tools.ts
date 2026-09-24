import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "voice-answers-after-tools",
  added: "2026-09-23T07:26:18Z",
  title: "Calls answer without a false error",
  summary:
    "Asking for something on a call no longer shows “I couldn’t get that answer out loud” before the reply, and a goodbye or hand-over is heard in full.",
  kind: "fix",
} satisfies WhatsNewEntryFileV1;
