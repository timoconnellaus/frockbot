import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "several-accounts",
  added: "2026-09-30T04:43:44Z",
  title: "Several accounts, several servers",
  summary:
    "The app signs in to frockbot.com and to servers people run themselves, side by side. Each account keeps its own Bots and unread.",
  kind: "feature",
  image: {
    file: "several-accounts.webp",
    alt: "The account switcher open over the Bot list, listing frockbot.com and bots.example.org with three unread, and Add an account.",
  },
} satisfies WhatsNewEntryFileV1;
