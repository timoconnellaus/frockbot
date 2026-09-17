# Examples

_A reference of `managed/a2ui`. Three complete cards, as they are actually
sent._

## 1. A draft the User approves

Two sends in one reply: the card, then the approval whose id the card's
`ApprovalActions` names. Seven components, one for the pill, one for the facts,
one for the body.

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
              "component": "Row",
              "justify": "spaceBetween",
              "align": "center",
              "children": ["title", "pill"]
            },
            {
              "id": "title",
              "component": "Text",
              "text": "Draft reply",
              "variant": "h4",
              "weight": 1
            },
            {
              "id": "pill",
              "component": "StatusPill",
              "label": { "path": "/status" },
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
