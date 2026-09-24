import type { WhatsNewEntryFileV1 } from "../entry.ts";

export default {
  id: "mcp-servers",
  added: "2026-09-24T07:08:24Z",
  title: "Your own MCP servers",
  summary:
    "Add a remote MCP server by its address, with a token if it asks for one. Every Bot you own gets its tools.",
  kind: "feature",
  image: {
    file: "mcp-servers.webp",
    alt: "The Marketplace with the MCP servers card open: a server address, a name, an optional access token, and an Add server button.",
  },
} satisfies WhatsNewEntryFileV1;
