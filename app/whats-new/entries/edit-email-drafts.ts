import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "edit-email-drafts",
  added: "2026-09-24T07:04:02Z",
  title: "Edit an email before it goes",
  summary:
    "A Bot’s email draft arrives with its recipients, subject and message as fields. Change any of them, and Send sends your version.",
  kind: "feature",
  image: {
    file: "edit-email-drafts.webp",
    alt: "An email draft card in the conversation: To with a second recipient added, Cc, Subject and Message as fields, and Send and Discard buttons.",
  },
} satisfies WhatsNewEntryFileV1;
