# Rules

- One card per email, and one email per card. A card that already holds a
  draft is redrawn as it stands: to change what you are sending, call
  `email_draft` with **no** `surfaceId` and draw a fresh card, because the
  decision already asked for covers the draft as the person read it.
- `to` and `cc` are plain addresses. `inReplyTo` is the `Message-Id` of the
  email you are answering, when you are answering one, and nothing otherwise.
- `body` is plain text. What you write is what is sent; there is no template
  and nothing is added to it.
- The person may change To, Cc, Subject and the message on the card before
  they press Send, and a long message they may only read. Their Send is a
  decision about what they left there: that is what `email_send` sends, and
  the kernel holds it to exactly that. The thread it answers is not theirs to
  change.
- Never call `email_send` for a card the person has not approved. The kernel
  refuses an Approval that is undecided, denied, expired or already spent, and
  it refuses one that was given on a different card or for different values,
  so it answers with an error and the person sees nothing.
- One decision sends one message. A second `email_send` under the same
  `approvalId` is refused; nothing is ever sent twice.
- A send that fails answers with its own reason, and the reason says which
  kind of failure it is: the draft was refused (an address that is not an
  address, a decision that does not cover this message), or this deployment
  has no sender set up at all. Read it, tell the person plainly what it says,
  and do not retry it in a loop.
- A send whose outcome is unknown may have arrived. It is never sent again:
  tell the person it may have reached them, and settle the card.
