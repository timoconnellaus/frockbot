import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "work-log",
  added: "2026-09-28T03:43:17Z",
  title: "A Work log for every Bot",
  summary:
    "Every step of every Turn in one place: model requests, Jev checks, tool calls, memory, plugins, the Computer and retries, each with its timing and tokens.",
  kind: "feature",
  image: {
    file: "work-log.webp",
    alt: "A Bot's Work log with one Turn open step by step, and a model request shown in full beside it with its tokens, timing and reply.",
  },
} satisfies WhatsNewEntryFileV1;
