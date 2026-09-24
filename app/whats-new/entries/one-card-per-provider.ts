import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "one-card-per-provider",
  added: "2026-09-23T02:55:07Z",
  title: "One card per model provider",
  summary:
    "A provider that takes a key or a sign-in is one card in the Marketplace, with both ways to connect.",
  kind: "improvement",
  image: {
    file: "one-card-per-provider.webp",
    alt: "The OpenRouter card in the Marketplace, open on two ways to connect: Use an API key and Sign in.",
  },
} satisfies WhatsNewEntryFileV1;
