# The loop

## To your person

Call `email_owner` with the note:

```json
{ "data": { "subject": "Re: Tuesday's agenda", "body": "The whole message." } }
```

It sends at once, from your address to the one they sign in with, and the
card in the conversation says "Emailed you". Add `"to"` only to reach
another of their own confirmed addresses. There is no decision to wait for,
and calling it again draws a new note: call it once per note.

## To anyone else

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
   this email takes it. The card shows To, Cc, Subject and the message as
   fields the person can change, and asks them to Send or Discard, so the
   call ends your Turn — say what you drafted and why in the same Turn,
   before you draw it.

2. **Wait.** Their decision arrives as durable input on a later Turn, the way
   every approval does. The line names the decision _and_ its id:
   `[Approval] The decision on "card-approval-…" is approved.` Nothing is sent
   in the meantime.

3. **On approved**, call `email_send` with that `surfaceId` and the
   `approvalId` from that line. The kernel checks the decision itself, so a
   wrong or missing id sends nothing. It sends what the card holds — which is
   the person's version when they edited it, and the answer says so; do not
   argue with their changes or send your draft again. Then call `email_draft`
   again with the same `surfaceId` and the same values: the card settles into
   a receipt — "Sent to nick@… — Re: Following up" — where the controls were.

4. **On denied**, call `email_discard` with that `surfaceId`, then draw the
   card once more the same way. It settles into a discarded receipt.
