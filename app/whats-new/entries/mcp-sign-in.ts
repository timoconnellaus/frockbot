import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "mcp-sign-in",
  added: "2026-09-24T10:08:06Z",
  title: "Sign in to MCP servers",
  summary:
    "An MCP server that asks you to sign in opens its own sign-in and stays signed in. A server’s token changes in place.",
  kind: "feature",
  image: {
    file: "mcp-sign-in.webp",
    alt: "The MCP servers card with two servers: DeepWiki is ready, and Linear says the server asks you to sign in, with a Sign in button beneath.",
  },
} satisfies WhatsNewEntryFileV1;
