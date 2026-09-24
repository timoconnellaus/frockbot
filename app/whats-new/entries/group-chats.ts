import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "group-chats",
  added: "2026-09-23T11:34:48Z",
  title: "Group Chats",
  summary:
    "Talk with several Bots at once. Every Bot in the group reads every message, and the ones with something to add reply.",
  kind: "feature",
  image: {
    file: "group-chats.webp",
    alt: "A Group Chat called Launch beside the Bot list: the person asks @Ledger about the budget, Ledger and Fox reply under their coloured badges, and Ledger and Pixel work at the end of the thread.",
  },
} satisfies WhatsNewEntryFileV1;
