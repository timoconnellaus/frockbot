import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "connect-app-card",
  added: "2026-09-24T03:13:42Z",
  title: "Bots offer the app they need",
  summary:
    "Ask a Bot about your Gmail before it is connected and it puts Gmail in the conversation with a Connect button. You sign in on Gmail’s own page.",
  kind: "feature",
  image: {
    file: "connect-app-card.webp",
    alt: "A card in the conversation: the Bot's reason, the Gmail logo and description, and a Connect Gmail button.",
  },
} satisfies WhatsNewEntryFileV1;
