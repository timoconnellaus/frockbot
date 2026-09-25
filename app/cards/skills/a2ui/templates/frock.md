# Frock components

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

These seven are the core of FrockBot's own catalog, drawn from the app's own
theme, and they are what most cards are made of. Reach for them **before**
composing the same thing out of `Row`s and `Text`s: they cost fewer
components, they look like the rest of the app, and four of them do things
the standard catalog cannot. The rest of the Frock catalog is five more
references — `structure.md` for the frame, `data.md` for numbers and rows,
`rich-text.md` for words, `media.md` for pictures, files and links, and
`input.md` for the answers a card takes. Load the one you need.

- **`StatusPill`** — one per card, saying what state the card is in. Bind its
  `label` to the data model and the card settles with one small
  `updateDataModel`. For the usual title-and-pill line, do not build it: use
  `CardHeader` (`structure.md`), which lays out both and cannot overflow.
- **`KeyValueRows`** — the facts about the thing: From, To, Cc, Subject. One
  component for the whole block. Never use it as a form.
- **`CollapsibleText`** — a body longer than the card: a draft, a quote, a
  summary. It starts collapsed so the controls stay visible.
- **`ApprovalActions`** — the approve and decline controls for one Approval.
- **`ConnectApp`** — an app from the Marketplace the person can connect, with
  its logo and a Connect button.
- **`SecretField`** — the field a secret is typed into. The host's alone; you
  never compose one.
- **`Receipt`** — what a card settles into.

## `ApprovalActions` is bound, not composed

Its meaning is not the card's. You give it an
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

## `ConnectApp` names an app, and the host does the rest

Give it `app` — the Marketplace id (`gmail`, `googlecalendar`) or the app's
name (`Google Calendar`) — and nothing else. The kernel looks the app up in its
own catalog when the card is sent and writes its name and ids onto the
component, replacing anything you wrote there; an app the Marketplace does not
carry is refused, and the refusal names the closest ones it does. The host
draws the logo, the name and the button, so the button always connects the app
it names.

A press never reaches you. The person signs in on the app's own page, and the
app's tools appear in your prompt on a later Turn. For the usual "want me to
connect Gmail?" card, do not compose one: call `connectors_offer` from the
`connectors` namespace, which draws this component with your reason above it.

## `SecretField` is the host's alone

The masked field a person types a password, card number or other secret into.
You never compose one: a card of yours that carries a `SecretField` is refused.
Ask with a `send_to_user` `secret-request` — `prompt`, `secretName`, and the
site it is for in `origin` — and the host draws the card with the field on it,
bound to a request the kernel records. What is typed goes to the person's
account and never to the card or to you; once they save it you get a reference
(`secret-…`) on a later Turn, and `computer_browser` fills it into a page.

## Settling

A card never disappears when the thing is done. Replace the controls with a
`Receipt` — the title it already had, the pill saying what happened, one line
saying what was done — or, if the card was only ever a `StatusPill` and some
facts, move the pill's `tone` to `success` and write the new label. Both are
one more `card` send naming the same `surfaceId`.

## Components

<!-- components: StatusPill, KeyValueRows, CollapsibleText, ApprovalActions, ConnectApp, SecretField, Receipt -->
