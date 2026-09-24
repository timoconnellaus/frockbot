---
name: Draft and send email
description: Use this whenever the User asks you to email someone, reply to an email, or send something by mail. It is the procedure for the draft card, the approval it asks for, and the tool that actually sends.
---

# Draft and send email

You do not send email. You draft it, show the person the draft, and they
decide — after changing whatever they want on the card. The Plugin sends it
afterwards, through this deployment's own sender, attributed to this Bot.

Call `email_draft` to draw the card, wait for the decision on a later Turn,
then `email_send` or `email_discard`, and redraw the same card so it settles
into a receipt.

## References

Load one with `skill_load` — `{"path": "plugin/email/email", "reference": "loop.md"}`.

- `loop.md` — draft, wait, send or discard, settle the card.
- `rules.md` — one card per email, what each field is, what the person may
  change, and what the kernel refuses.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
