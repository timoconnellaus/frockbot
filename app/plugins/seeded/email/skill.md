---
name: Draft and send email
description: Use this whenever the User asks you to email someone, reply to an email, or send something by mail. It is the procedure for the draft card, the approval it asks for, and the tool that actually sends.
---

# Draft and send email

You do not send email. You draft it, show the person the draft, and they
decide. The Plugin sends it afterwards, through this deployment's own sender,
attributed to this Bot.

## The loop

1. **Draw the draft.** Call `email_draft` with the values:

   ```json
   {
     "data": {
       "to": ["nick@example.com"],
       "cc": [],
       "subject": "Re: Following up",
       "inReplyTo": "<message-id you are answering>",
       "body": "The whole message, as you would send it."
     }
   }
   ```

   It answers with the card's `surfaceId`. Keep it: every later call about
   this email takes it. The card asks the person to Send or Discard, so the
   call ends your Turn — say what you drafted and why in the same Turn, before
   you draw it.

2. **Wait.** Their decision arrives as durable input on a later Turn, the way
   every approval does. The line names the decision _and_ its id:
   `[Approval] The decision on "card-approval-…" is approved.` Nothing is sent
   in the meantime.

3. **On approved**, call `email_send` with that `surfaceId` and the
   `approvalId` from that line. The kernel checks the decision itself, so a
   wrong or missing id sends nothing. It sends and tells you it did — and if
   it names addresses it did not reach, tell the person; never send again.
   Then call `email_draft` again with the same `surfaceId` and the same
   values: the card settles into a receipt — "Sent to nick@… — Re: Following
   up" — where the controls were.

4. **On denied**, call `email_discard` with that `surfaceId`, then draw the
   card once more the same way. It settles into a discarded receipt.

## Rules

- One card per email, and one email per card. A card that already holds a
  draft is redrawn as it stands: to change what you are sending, call
  `email_draft` with **no** `surfaceId` and draw a fresh card, because the
  decision already asked for covers the draft as the person read it.
- `to` and `cc` are plain addresses. `inReplyTo` is the `Message-Id` of the
  email you are answering, when you are answering one, and nothing otherwise.
- `body` is plain text. What you write is what is sent; there is no template
  and nothing is added to it.
- Never call `email_send` for a card the person has not approved. The kernel
  refuses an Approval that is undecided, denied, expired or already spent, and
  it refuses one that was given on a different card or for different values,
  so it answers with an error and the person sees nothing.
- One decision sends one message. A second `email_send` under the same
  `approvalId` is refused; nothing is ever sent twice.
- A send that fails answers with its own reason, and the reason says which
  kind of failure it is: the draft was refused (an address that is not an
  address, a decision that does not cover this message), or this deployment
  has no sender bound at all. Read it, tell the person plainly what it says,
  and do not retry it in a loop.
