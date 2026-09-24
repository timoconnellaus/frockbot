import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "secret-fill",
  added: "2026-09-24T11:58:45Z",
  title: "Passwords your Bot never sees",
  summary:
    "A Bot can ask you for a password or card and fill it in without seeing it. Saved secrets stay in your account.",
  kind: "feature",
  image: {
    file: "secret-fill.webp",
    alt: "A Bot asks for a coffee shop password in a card with a masked field, a Save button and the note “Your Bot never sees it”.",
  },
} satisfies WhatsNewEntryFileV1;
