# ADR 0033: Conversation authors a Routine

Status: accepted, 2026-09-20. Numbered after ADR 0032.

## Context

Routines already have one write path: `routine_manage` posts the same
commands the client posts (`app/routines/agent.ts`). The Flutter editor
was a second author that could not express provider `config`, invented
`connection:<connectionId>:<triggerType>` timing strings, and is what
would have forced Gmail label ids onto a form.

Connected-app events (Cut 3 of [connected apps](../plan.md#11-connected-apps))
made that worse: a trigger's useful config is a coarse search the Bot
writes, not knobs a person should type.

## Decision

Conversation is the only author. The Routines surface is a list and a
read-only detail: name, prompt, trigger in words, optional provider
`config`, recent runs. Pause, resume, delete, run now, and webhook
rotate/revoke stay chrome. There is no create/edit form, no New Routine
button, and no tap-the-Routine-to-cite-in-chat gesture.

The prompt is the description of what kind of event the Routine is for.
There is no second `match` field. `userAsked` stays for Routines the User
already created; new ones are Bot-authored.

## Consequences

- The write path accepts only `config.query`. Chrome never collects
  `labelIds`, `userId`, or `interval`.
- Existing User-authored records keep `createdBy.kind === "user"`. Pause
  and delete in the list remain User chrome and need no `userAsked`.
- A webhook key is still minted once and shown once, on the receipt.
  Rotate stays on the detail; a secret the authority minted once is still
  never in a document.

The Jev rejector that may skip a clearly unrelated connected-app event is
a later cut of the same plan, now landed in
[architecture.md](../architecture.md) §8.
