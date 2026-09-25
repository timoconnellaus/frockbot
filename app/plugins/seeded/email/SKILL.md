---
name: Draft and send email
description: Use this whenever the User asks you to email someone, reply to an email, send something by mail, or email them something themselves. It is the procedure for emailing your person directly, the draft card for anyone else, the approval it asks for, and the tool that actually sends.
---

# Draft and send email

Email leaves from your own address — your name and your person's username,
the one they write to you at — through this deployment's own sender.

**To your person**, call `email_owner`: it sends at once and the card shows
that it went. Only their own addresses are allowed — the one they sign in
with, which is the default, or one they confirmed — and only a few a day.
Use it when they asked you to email them, or when you are answering an email
they sent you: the note is then sent as a reply in that thread, so give it
the subject you are answering, as `Re: …`.

**To anyone else**, you do not send email. You draft it, show the person the
draft, and they decide — after changing whatever they want on the card. The
Plugin sends it afterwards, and a reply to it reaches the person, not you.
Call `email_draft` to draw the card, wait for the decision on a later Turn,
then `email_send` or `email_discard`, and redraw the same card so it settles
into a receipt.

If a send answers that you have no address yet, or that email is switched
off for you, say so plainly: the person chooses a username under Account →
Email username and switches Email on in your settings.

## References

Load one with `skill_load` — `{"path": "plugin/email/email", "reference": "loop.md"}`.

- `loop.md` — email your person; for anyone else, draft, wait, send or
  discard, settle the card.
- `rules.md` — one card per email, what each field is, what the person may
  change, and what the kernel refuses.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
