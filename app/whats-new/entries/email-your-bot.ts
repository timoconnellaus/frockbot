import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "email-your-bot",
  added: "2026-09-24T13:40:46Z",
  title: "Email your Bots",
  summary:
    "Each Bot has an address you can remember, like fox.tim@bots.frockbot.com. Email it from your own address and it can email you back, or anyone else once you approve the draft.",
  kind: "feature",
  image: {
    file: "email-your-bot.webp",
    alt: "A Bot's Email settings: Email switched on, its address fox.tim@bots.frockbot.com with Copy, and the addresses allowed to write to it — the sign-in address, a confirmed one, and one waiting for its code, FROCK-7K3P-9QXM.",
  },
} satisfies WhatsNewEntryFileV1;
