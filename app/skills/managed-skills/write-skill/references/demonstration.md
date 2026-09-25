# Learn a Skill from a demonstration

The User took control of the Computer, pressed Record, did a task in the
browser, and sent it to you. The message carries `demonstration-<id>.json`
and up to four `demonstration-<id>-screenshot-<n>.jpg` files.

## What the log is

- `steps` — what they did, in order. Each has `action` (`navigate`,
  `switch-tab`, `click`, `type`, `choose`, `key`), `tab`, `t` (seconds since
  the start), and for an element its `role`, `name` (the label) and a CSS
  `selector`.
- `type` says which field was typed into, never what was typed. `choose` says
  which list was chosen from, never which option. A URL keeps its query's
  names and drops their values (`?q=…`).
- Nothing was recorded in a password, one-time-code or card-number field —
  not even that it was used. If a step is missing between two others, that is
  probably why.
- `screenshots` names each picture and the step it follows. Every form field
  is covered in them.
- Only the browser, in your own window, was recorded. Anything done in
  another app on the desktop is not in the log.

## What to do

1. Read the log and the screenshots. If the log is long, you may hand it to
   an `executor` `Task` with the files as its `attachments`, by name; it sees
   them as its own message's. Its summary is your draft.
2. Draft one Skill. The description starts "Use this when …". The body is the
   task as steps you would take with `computer_browser`: where to go, what to
   click by role and name, which field to fill with what. Where the User typed
   something, say what belongs there — "the User's email", "the date they ask
   for" — never a value you guessed. A step you cannot tell from the log is a
   question for the User, not an invention.
3. Show the draft before you save it: one `send_to_user` of type `approval`
   whose `action` is "Save the Skill "<name>" for all your Bots" and whose
   `rationale` is the draft `SKILL.md` in full. The User decides on the card.
4. When the decision arrives:
   - Approved: write it with `skill_write`, `scope: "user"`, exactly as
     shown, so every one of their Bots can use it. It is visible from your
     next Turn.
   - Denied or expired: write nothing. Ask what to change if they said.
5. Either way, then call `demonstration_delete` with the `demonstration` id
   from the log. The recording is theirs; once its Skill is decided it goes.
   If you forget, it is deleted a week after it was recorded anyway.

Never save a Skill from a demonstration before the User approves it.
