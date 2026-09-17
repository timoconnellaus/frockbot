# Frock components

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

These five are the core of FrockBot's own catalog, drawn from the app's own
theme, and they are what most cards are made of. Reach for them **before**
composing the same thing out of `Row`s and `Text`s: they cost fewer
components, they look like the rest of the app, and two of them do things the
standard catalog cannot. `structure.md` is the rest of the same catalog's
frame; load it when a card needs more than these five.

- **`StatusPill`** — one per card, saying what state the card is in. Bind its
  `label` to the data model and the card settles with one small
  `updateDataModel`. For the usual title-and-pill line, do not build it: use
  `CardHeader` (`structure.md`), which lays out both and cannot overflow.
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

### `StatusPill`

A small pill stating what state the card is in. One per card, beside its title.

| Property | Type                                                       | Required | Binding  | What it is                                                                                                                                                                                |
| -------- | ---------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`  | DynamicString                                              | yes      | bindable | The words on the pill, e.g. 'Ready to send' or 'Sent'. Bind this to the data model when the card settles.                                                                                 |
| `tone`   | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What the state means, which is what the host colours the pill by. 'ready' is waiting on the person, 'success' is done, 'warning' needs attention, 'danger' failed. Defaults to 'neutral'. |

```json
{
  "id": "root",
  "component": "StatusPill",
  "label": "…label…"
}
```

### `KeyValueRows`

Labelled values in a column, one per row: From, To, Cc, Subject. For facts about the thing the card shows, never as a form.

| Property | Type                                             | Required | Binding                       | What it is                            |
| -------- | ------------------------------------------------ | -------- | ----------------------------- | ------------------------------------- |
| `rows`   | array of { label: string, value: DynamicString } | yes      | literal rows; values bindable | The rows, in the order they are read. |

```json
{
  "id": "root",
  "component": "KeyValueRows",
  "rows": [
    {
      "label": "…label…",
      "value": "…value…"
    }
  ]
}
```

### `CollapsibleText`

A body of text that starts collapsed, with a control that shows the rest. For a draft, a quote, or anything longer than the card.

| Property         | Type          | Required | Binding  | What it is                                                          |
| ---------------- | ------------- | -------- | -------- | ------------------------------------------------------------------- |
| `text`           | DynamicString | yes      | bindable | The body. Plain text; a card is not a document.                     |
| `collapsedLines` | integer       | no       | literal  | How many lines are shown before the control appears. Defaults to 6. |

```json
{
  "id": "root",
  "component": "CollapsibleText",
  "text": "…text…"
}
```

### `ApprovalActions`

The approve and decline controls for one Approval the kernel issued. Compose it into a card; the host draws the buttons and names the actions, and the decision is recorded once and durably.

| Property       | Type   | Required | Binding | What it is                                                                                                                                                  |
| -------------- | ------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalId`   | string | yes      | literal | The id the kernel issued when the Bot proposed the action. A card cannot invent one: an id the kernel never recorded is refused when the button is pressed. |
| `approveLabel` | string | no       | literal | The word on the approving control. Defaults to 'Approve'.                                                                                                   |
| `declineLabel` | string | no       | literal | The word on the declining control. Defaults to 'Decline'.                                                                                                   |

```json
{
  "id": "root",
  "component": "ApprovalActions",
  "approvalId": "…approvalId…"
}
```

### `Receipt`

What a card settles into: its title, the pill saying what happened, and one line summarising it. Use it in place of the controls once the thing is done.

| Property  | Type                                                       | Required | Binding  | What it is                                                                                  |
| --------- | ---------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------- |
| `title`   | DynamicString                                              | yes      | bindable | The same title the card carried before it settled.                                          |
| `status`  | DynamicString                                              | yes      | bindable | The words on the pill, e.g. 'Sent'.                                                         |
| `tone`    | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What the state means. Defaults to 'success', because a receipt usually says a thing worked. |
| `summary` | DynamicString                                              | no       | bindable | One line saying what was done, e.g. 'Sent to nick@example.com — Re: Following up'.          |

```json
{
  "id": "root",
  "component": "Receipt",
  "title": "…title…",
  "status": "…status…"
}
```
