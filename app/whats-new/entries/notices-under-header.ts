import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "notices-under-header",
  added: "2026-09-23T05:02:22Z",
  title: "Chat notices sit under the header",
  summary:
    "Offline, paused and out-of-credit notices are no longer hidden behind it, and Reconnect and Open Billing can be pressed.",
  kind: "fix",
  image: {
    file: "notices-under-header.webp",
    alt: "A phone chat with Fox: under the header, the notice “You’re offline. Your Bot can keep working.” with Reconnect beside it.",
  },
} satisfies WhatsNewEntryFileV1;
