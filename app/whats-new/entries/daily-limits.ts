import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "daily-limits",
  added: "2026-09-25T07:07:16Z",
  title: "Daily spending limits",
  summary:
    "Give a Bot or a Routine a daily limit. Past it, its Routines and background work pause until midnight, and you hear when a Routine spends far more than usual.",
  kind: "feature",
  image: {
    file: "daily-limits.webp",
    alt: "The Spending page's breakdown: Morning digest with a US$1.00 daily limit, and Inbox triage paused until midnight at its US$0.25 limit.",
  },
} satisfies WhatsNewEntryFileV1;
