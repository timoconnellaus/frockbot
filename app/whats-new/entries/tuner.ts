import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "tuner",
  added: "2026-09-24T06:29:23Z",
  title: "A tuner in the panel",
  summary:
    "Tuner ships with FrockBot, off until you switch it on for a Bot. Its panel hears a string through your microphone and shows the note and how far off it is.",
  kind: "feature",
  image: {
    file: "tuner.webp",
    alt: "A Bot’s Plugins page: Email switched off, and Tuner, which tunes a guitar or any string by ear, switched on.",
  },
} satisfies WhatsNewEntryFileV1;
