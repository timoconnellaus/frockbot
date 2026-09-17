# Frock components

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

These five are FrockBot's own, drawn from the app's own theme, and they are
what most cards are made of. Reach for them **before** composing the same thing
out of `Row`s and `Text`s: they cost fewer components, they look like the rest
of the app, and two of them do things the standard catalog cannot.

- **`StatusPill`** — one per card, beside its title, saying what state the card
  is in. Bind its `label` to the data model and the card settles with one small
  `updateDataModel`. Put the title and the pill in a `Row` with
  `"justify": "spaceBetween"` and `"weight": 1` on the title, or on a phone the
  pill runs off the edge of the card.
- **`KeyValueRows`** — the facts about the thing: From, To, Cc, Subject. One
  component for the whole block. Never use it as a form.
- **`CollapsibleText`** — a body longer than the card: a draft, a quote, a
  summary. It starts collapsed so the controls stay visible.
- **`ApprovalActions`** — the approve and decline controls for one Approval.
- **`Receipt`** — what a card settles into.

## `ApprovalActions` is bound, not composed

This is the one component whose meaning is not the card's. You give it an
`approvalId`; the host draws both buttons, mints their action names as
`approval/<approvalId>`, and the decision is recorded once, durably, by the
kernel.

**The id must be one the kernel already issued.** You cannot mint one: an id
the kernel never recorded is refused when the button is pressed, and the person
gets nothing. So the approval and the card go out together, in the same reply:

```text
[
  { "disposition": "continue", "payload": { "type": "card", "surfaceId": "draft-nick", "messages": [ … ] } },
  { "disposition": "finish", "payload": {
      "type": "approval", "approvalId": "appr-nick-retainer",
      "action": "Send the drafted reply to nick@example.com", "risk": "medium" } }
]
```

The card's `ApprovalActions` carries `"approvalId": "appr-nick-retainer"`, the
same string. Write no `action` on it — the host owns those names, which is what
makes the buttons trustworthy.

The approval send ends your Turn. The decision reaches you as input on a later
Turn; that is when you update the card to its settled state.

## Settling

A card never disappears when the thing is done. Replace the controls with a
`Receipt` — the title it already had, the pill saying what happened, one line
saying what was done — or, if the card was only ever a `StatusPill` and some
facts, move the pill's `tone` to `success` and write the new label. Both are
one more `card` send naming the same `surfaceId`.

## Components

<!-- components: StatusPill, KeyValueRows, CollapsibleText, ApprovalActions, Receipt -->
