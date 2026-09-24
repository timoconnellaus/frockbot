import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "replies-as-written",
  added: "2026-09-24T07:05:18Z",
  title: "Replies appear as they are written",
  summary:
    "A Bot's message fills in word by word while it writes, instead of arriving all at once.",
  kind: "feature",
  image: {
    file: "replies-as-written.webp",
    alt: "The end of a phone chat with Fox: under “Draft the investor update from those notes”, Fox’s reply stops mid-word at “bridge clo”, with Fox working below it.",
  },
} satisfies WhatsNewEntryFileV1;
