import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "attachments",
  added: "2026-09-24T07:42:59Z",
  title: "Files and photos in a message",
  summary:
    "Attach pictures, PDFs, Office documents and text files to a message. The Bot sees the pictures and reads the documents.",
  kind: "feature",
  image: {
    file: "attachments.webp",
    alt: "A conversation with Fox: a message carries a chart of weekly signups and a launch plan PDF, Fox explains the dip in week 6 from both, and the composer holds a spreadsheet attached to the next message.",
  },
} satisfies WhatsNewEntryFileV1;
