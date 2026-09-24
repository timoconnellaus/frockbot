# Frock components

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

These six are the core of FrockBot's own catalog, drawn from the app's own
theme, and they are what most cards are made of. Reach for them **before**
composing the same thing out of `Row`s and `Text`s: they cost fewer
components, they look like the rest of the app, and three of them do things
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

### `ConnectApp`

An app from the Marketplace the person can connect: its logo, its name and a Connect button that opens the app's own sign-in. Name the app and nothing else; the host fills in the rest from its own catalog and draws the button, so a card can never say one app and connect another. A press never reaches you: the person signs in on the app's page, and the app's tools reach you on a later Turn.

| Property           | Type   | Required | Binding | What it is                                                                                                                                                                                                                  |
| ------------------ | ------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`              | string | yes      | literal | The app: its Marketplace id, e.g. 'gmail' or 'googlecalendar', or its name, e.g. 'Google Calendar'. An app the Marketplace does not carry is refused when the card is sent, and the refusal names the closest ones it does. |
| `name`             | string | no       | literal | Written by the host from its own catalog. Whatever a card puts here is replaced.                                                                                                                                            |
| `description`      | string | no       | literal | Written by the host from its own catalog. Whatever a card puts here is replaced.                                                                                                                                            |
| `packageId`        | string | no       | literal | Written by the host from its own catalog. Whatever a card puts here is replaced.                                                                                                                                            |
| `connectionTypeId` | string | no       | literal | Written by the host from its own catalog. Whatever a card puts here is replaced.                                                                                                                                            |

```json
{
  "id": "root",
  "component": "ConnectApp",
  "app": "…app…"
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
