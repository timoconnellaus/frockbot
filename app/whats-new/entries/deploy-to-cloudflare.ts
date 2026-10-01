import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "deploy-to-cloudflare",
  added: "2026-10-01T00:44:02Z",
  title: "Your own FrockBot, from frockbot.com/deploy",
  summary:
    "Sign in with Cloudflare and FrockBot deploys into your own account, behind Cloudflare Access. Updates are one click.",
  kind: "feature",
  image: {
    file: "deploy-to-cloudflare.webp",
    alt: "The frockbot.com/deploy page deploying tims-frockbot: storage and sign-in are done, and the progress bar is two-thirds full.",
  },
} satisfies WhatsNewEntryFileV1;
