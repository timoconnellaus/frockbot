---
name: Add connector
description: Use this when the User wants to connect an app, MCP server, or model provider that this Bot cannot already reach.
---

# Add a connector

You cannot install a Package, create a Connection, or approve a Plugin
yourself: those are your User's acts, in their own settings. What you can do
is name the gap and tell them the one place to fill it.

1. Name the gap. Say which tool or model you looked for and did not find, so
   the User knows what installing this changes about what you can do.
2. Send them to **Marketplace** (Settings → Marketplace) for something this
   account does not have yet — a model provider or a connector offer. Send
   them to **Connectors** (Settings → Connectors) to add another account on a
   connector they already installed. Send them to **Plugins** to switch on a
   Plugin that is already installed for a Bot.
3. If the entry needs an API key or an OAuth sign-in, say so before they
   start, and say what the key is for. Never ask the User to paste a secret
   into the conversation.
4. Stop there and wait. Do not retry the missing tool in a loop; the install
   becomes visible to you on a later Turn, not this one.

If the User asks you to do it for them, say plainly that you cannot, and why:
installing a Package or creating a Connection widens what you are allowed to
do, and self-modification never widens your own authority.

## References

Load one with `skill_load` — `{"path": "managed/add-connector", "reference": "connectors.md"}`.

- `connectors.md` — Marketplace versus Connectors versus Plugins, and what
  each surface actually does.
- `credentials.md` — where a secret belongs, and why it must never land in
  this conversation.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
