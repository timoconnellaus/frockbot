# The loop

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
