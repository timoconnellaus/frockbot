---
name: Export bot template
description: Use this when the User wants to reuse this Bot's setup for another Bot, or to keep a record of how it is configured.
---

# Export a bot template

A template is a shareable recipe of this Bot, not a backup and not a file you
compose by hand.

1. Call `bot_export_template`. It packs you into a private share: name,
   description, your own Skills, your Routines' prompts, the Catalog Packages
   your User installed, and public MCP server addresses.
2. The tool stages the share and draws a card naming what was packed and what
   was scrubbed. Nothing is shared with anyone yet.
3. Tell the User that only they can publish it, from this Bot's settings —
   private, a link, or public. There is no tool argument and no second tool
   that could do that for them.

Do not write the template as Markdown. Do not copy Skill bodies into Memory
or into a new Skill as a stand-in. `bot_export_template` is the pack.

## References

Load one with `skill_load` — `{"path": "managed/export-bot-template", "reference": "what-it-carries.md"}`.

- `what-it-carries.md` — what the pack includes, and what it must never
  include.
- `publication.md` — staging versus publishing, and who may change
  visibility.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
