import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "spending",
  added: "2026-09-25T02:10:02Z",
  title: "See where your credit goes",
  summary:
    "Spending breaks your usage down by Bot, by what started it — a Routine, a chat, a Group Chat — and by model, day and Turn.",
  kind: "feature",
  image: {
    file: "spending.webp",
    alt: "The Spending page: thirty days of daily bars, then spending grouped by what started it, with a Morning digest Routine at the top.",
  },
} satisfies WhatsNewEntryFileV1;
