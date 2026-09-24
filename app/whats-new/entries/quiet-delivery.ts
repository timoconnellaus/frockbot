import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "quiet-delivery",
  added: "2026-09-22T05:39:09Z",
  title: "Sends acknowledge immediately",
  summary:
    "A message is accepted as soon as it is saved. A long reply no longer looks like the send failed.",
  kind: "fix",
} satisfies WhatsNewEntryFileV1;
