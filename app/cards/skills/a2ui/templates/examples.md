# Examples

_A reference of `managed/a2ui`. Four complete cards, as they are actually
sent._

## 1. A draft the User approves

Two sends in one reply: the card, then the approval whose id the card's
`ApprovalActions` names. Five components: the header, the facts, the body, the
decision. The header carries the title and the state pill together, so nothing
about the layout is left for the card to get wrong.

```json
{
  "disposition": "continue",
  "payload": {
    "type": "card",
    "surfaceId": "draft-nick-retainer",
    "messages": [
      {
        "version": "v1.0",
        "createSurface": {
          "surfaceId": "draft-nick-retainer",
          "components": [
            {
              "id": "root",
              "component": "Column",
              "children": ["header", "facts", "body", "decide"]
            },
            {
              "id": "header",
              "component": "CardHeader",
              "title": "Draft reply",
              "subtitle": "nick@example.com",
              "status": { "path": "/status" },
              "tone": "ready"
            },
            {
              "id": "facts",
              "component": "KeyValueRows",
              "rows": [
                { "label": "To", "value": "nick@example.com" },
                { "label": "Subject", "value": "Re: The retainer" }
              ]
            },
            {
              "id": "body",
              "component": "CollapsibleText",
              "text": { "path": "/body" },
              "collapsedLines": 6
            },
            {
              "id": "decide",
              "component": "ApprovalActions",
              "approvalId": "appr-nick-retainer",
              "approveLabel": "Send",
              "declineLabel": "Discard"
            }
          ],
          "dataModel": {
            "status": "Ready to send",
            "body": "Hi Nick,\n\nHappy to keep the retainer as it stands for another quarter — same scope, same monthly figure. If you'd like to revisit the hours, I can put a revised version together this week.\n\nThanks,\nTim"
          }
        }
      }
    ]
  }
}
```

```json
{
  "disposition": "finish",
  "payload": {
    "type": "approval",
    "approvalId": "appr-nick-retainer",
    "action": "Send the drafted reply to nick@example.com",
    "rationale": "It answers their question about the retainer and commits to nothing new.",
    "risk": "medium"
  }
}
```

Put both in one `batch` call. The card is drawn where the send sits; the
approval records the decision its buttons decide, and ends the Turn.

## 2. The same card, settled

On the Turn where the decision arrives, send the same `surfaceId` again.
`updateComponents` upserts by id, so redefining `root` with one child is enough
— the components it no longer names stay in the record and are simply not
drawn.

```json
{
  "disposition": "finish",
  "payload": {
    "type": "card",
    "surfaceId": "draft-nick-retainer",
    "messages": [
      {
        "version": "v1.0",
        "updateComponents": {
          "surfaceId": "draft-nick-retainer",
          "components": [
            { "id": "root", "component": "Column", "children": ["receipt"] },
            {
              "id": "receipt",
              "component": "Receipt",
              "title": "Draft reply",
              "status": "Sent",
              "tone": "success",
              "summary": "Sent to nick@example.com — Re: The retainer"
            }
          ]
        }
      }
    ]
  }
}
```

If the card's only moving part had been the pill, one `updateDataModel` would
have done it instead:

```json
{
  "version": "v1.0",
  "updateDataModel": {
    "surfaceId": "draft-nick-retainer",
    "path": "/status",
    "value": "Sent"
  }
}
```

## 3. A choice that comes back as input

No approval and no Plugin, so the press is conversation input. `sendDataModel`
carries the whole model with it, which is how the chosen value reaches you.

```json
{
  "disposition": "finish",
  "payload": {
    "type": "card",
    "surfaceId": "pick-slot-thursday",
    "messages": [
      {
        "version": "v1.0",
        "createSurface": {
          "surfaceId": "pick-slot-thursday",
          "sendDataModel": true,
          "components": [
            {
              "id": "root",
              "component": "Column",
              "children": ["question", "slots", "confirm"]
            },
            {
              "id": "question",
              "component": "Text",
              "text": "Which slot should I book with Nick?",
              "variant": "h4"
            },
            {
              "id": "slots",
              "component": "ChoicePicker",
              "label": "Available slots",
              "variant": "mutuallyExclusive",
              "displayStyle": "chips",
              "options": [
                { "label": "Tue 10:00", "value": "tue-1000" },
                { "label": "Wed 14:30", "value": "wed-1430" },
                { "label": "Thu 09:00", "value": "thu-0900" }
              ],
              "value": { "path": "/slot" }
            },
            {
              "id": "confirm",
              "component": "Button",
              "variant": "primary",
              "child": "confirmLabel",
              "action": {
                "event": {
                  "name": "book-slot",
                  "context": { "with": "nick@example.com" }
                }
              }
            },
            { "id": "confirmLabel", "component": "Text", "text": "Book it" }
          ],
          "dataModel": { "slot": [] }
        }
      }
    ]
  }
}
```

The press arrives on your next Turn as the action `book-slot` on surface
`pick-slot-thursday`, with its context and the data model. Book the slot, then
send the same `surfaceId` once more with a `Receipt`.

## 4. A report, with the answer it needs

One card carrying the frame, the numbers, the rows and the one thing the
person has to decide. Notice what is _not_ here: no `Row` of `Text`s for the
header, no table built out of rows, no per-option `CheckBox`. Every part is
one component, so the whole card is eleven.

```json
{
  "disposition": "finish",
  "payload": {
    "type": "card",
    "surfaceId": "invoices-september",
    "messages": [
      {
        "version": "v1.0",
        "createSurface": {
          "surfaceId": "invoices-september",
          "sendDataModel": true,
          "components": [
            {
              "id": "root",
              "component": "Column",
              "children": ["header", "totals", "items", "note", "chase", "send"]
            },
            {
              "id": "header",
              "component": "CardHeader",
              "title": "September invoices",
              "subtitle": "Four clients, two overdue",
              "status": { "path": "/status" },
              "tone": "ready"
            },
            {
              "id": "totals",
              "component": "Row",
              "children": ["outstanding", "overdue"]
            },
            {
              "id": "outstanding",
              "component": "MetricTile",
              "label": "Outstanding",
              "value": "$12,400",
              "delta": "+2,100",
              "caption": "since August"
            },
            {
              "id": "overdue",
              "component": "MetricTile",
              "label": "Overdue",
              "value": "2",
              "tone": "warning"
            },
            {
              "id": "items",
              "component": "DataTable",
              "columns": [
                { "label": "Client", "weight": 3 },
                { "label": "Due", "align": "end" },
                { "label": "Amount", "align": "end" }
              ],
              "rows": [
                { "cells": ["Harper & Co", "12 Sep", "$4,000"] },
                { "cells": ["Nightjar", "19 Sep", "$3,200"] },
                { "cells": ["Bellweather", "2 Oct", "$5,200"] }
              ],
              "caption": "Showing 3 of 4 — one is already paid"
            },
            {
              "id": "note",
              "component": "Callout",
              "tone": "warning",
              "text": "Harper & Co have been chased twice already."
            },
            {
              "id": "chase",
              "component": "MultiSelect",
              "values": { "path": "/chase" },
              "options": [
                { "label": "Harper & Co", "value": "harper" },
                { "label": "Nightjar", "value": "nightjar" }
              ]
            },
            {
              "id": "send",
              "component": "Button",
              "variant": "primary",
              "child": "sendLabel",
              "action": { "event": { "name": "chase-overdue" } }
            },
            { "id": "sendLabel", "component": "Text", "text": "Send reminders" }
          ],
          "dataModel": { "status": "Waiting on you", "chase": ["harper"] }
        }
      }
    ]
  }
}
```

The press arrives as the action `chase-overdue` with the data model —
`{"status": "Waiting on you", "chase": ["harper", "nightjar"]}` — so the
ticked list is the answer. Then settle the card: one `updateDataModel` on
`/status`, and a `Receipt` in place of the control.
