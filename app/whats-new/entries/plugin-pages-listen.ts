import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "plugin-pages-listen",
  added: "2026-09-24T04:58:09Z",
  title: "Plugins that listen",
  summary:
    "A Plugin’s panel can be its own page, and hear the microphone once you approve it — a guitar tuner, say. While it listens, a bar above it says so and has Stop.",
  kind: "feature",
  image: {
    file: "plugin-pages-listen.webp",
    alt: "A guitar tuner in a Bot’s panel reading A2, 12 cents flat, under a bar that says Tuner is using the microphone, with Stop.",
  },
} satisfies WhatsNewEntryFileV1;
