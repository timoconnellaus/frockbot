import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "email-your-bot",
  added: "2026-09-24T13:40:46Z",
  title: "Email your Bots",
  summary:
    "Choose a username and each Bot gets an address you can remember, like fox.tim@frockbot.com. What you send from your own address arrives in its conversation, files and all.",
  kind: "feature",
  image: {
    file: "email-your-bot.webp",
    alt: "A Bot's Email settings: Receive email switched on, its address fox.tim@frockbot.com with Copy, and the addresses allowed to write to it — the sign-in address, a confirmed one, and one waiting for its code, FROCK-7K3P-9QXM.",
  },
} satisfies WhatsNewEntryFileV1;
