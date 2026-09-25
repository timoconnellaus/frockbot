import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "learn-from-demonstration",
  added: "2026-09-24T12:45:51Z",
  title: "Teach a Bot by showing it",
  summary:
    "Record a task in the Computer's browser and send it to a Bot. It drafts a Skill from what you did for you to approve, then deletes the recording. What you type is never recorded.",
  kind: "feature",
  image: {
    file: "learn-from-demonstration.webp",
    alt: "The Computer's full window with a booking site on it: a recording of fourteen steps and three screenshots waits under “Teach Fox this?”, named “Book a squash court”, with Discard and Send to Fox.",
  },
} satisfies WhatsNewEntryFileV1;
