import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "steering",
  added: "2026-09-23T06:39:24Z",
  title: "A message sent mid-reply steers the Bot",
  summary:
    "It waits in the thread, and the Bot reads it at its next step instead of dropping what it was doing.",
  kind: "improvement",
  image: {
    file: "steering.webp",
    alt: "The end of a phone chat with Fox: under Fox’s “Starting with the runway numbers.”, the person’s next message waits greyed, with Fox working below it.",
  },
} satisfies WhatsNewEntryFileV1;
