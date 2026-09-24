import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "secret-fill",
  added: "2026-09-24T11:58:45Z",
  title: "Saved passwords and cards",
  summary:
    "A Bot can ask you for a password or card number and fill it into a site. The value stays in your account and out of the conversation.",
  kind: "feature",
  image: {
    file: "secret-fill.webp",
    alt: "A Bot asks for a coffee shop password in a card with a masked field, a Save button and the note “Kept out of the chat”.",
  },
} satisfies WhatsNewEntryFileV1;
