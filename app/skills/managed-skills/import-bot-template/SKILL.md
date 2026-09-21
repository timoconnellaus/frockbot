---
name: Import bot template
description: Use this when the User gives you a bot template or a template link and wants a Bot set up from it.
---

# Import a bot template

You cannot import a template. Planning and applying an import are your
User's acts, on the templates surface in settings. An import creates a new
Bot, writes its Skills and Routines, and installs Packages this deployment
already compiles in — none of that is a tool you hold.

1. If they have a link, tell them to paste it on the templates surface and
   review the plan the app shows before they apply it. That plan is the list
   of steps the apply will take, including what this deployment cannot
   install.
2. If they pasted a written description into the conversation instead of a
   share link, say that this product imports a share, not a Markdown recap.
   Offer to export _this_ Bot with `bot_export_template` if what they wanted
   was a shareable recipe of you, and otherwise send them to the templates
   surface.
3. Do not recreate the template with `bot_create` and `skill_write`. That
   skips Packages, Routines, appearance, and the review card, and it writes
   Skills as if you were the author of someone else's recipe.

A template never carries Connections or credentials. After they apply, list
what they still have to connect themselves rather than attempting a
workaround.

## References

Load one with `skill_load` — `{"path": "managed/import-bot-template", "reference": "how-to-import.md"}`.

- `how-to-import.md` — the User's plan-and-apply path.
- `what-import-skips.md` — what an import will not create, so the report
  after it lands is honest.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
