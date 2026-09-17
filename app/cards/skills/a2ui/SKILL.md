---
name: Show a card
description: Use this when you want to show the User something richer than text — a draft, a form, a list with controls, a thing they approve or decline, a state that settles into a receipt. It is the reference for cards: the components you may compose, how values bind, and what a press does.
---

# Show a card

A card is one surface you put in the conversation and keep. It is drawn by the
app from a fixed vocabulary of components — you compose them, you never write
code, and nothing you send runs anywhere. A card stays where you put it: a
later send with the same `surfaceId` changes it in place, so a draft can become
a receipt without a second bubble.

Use a card when the shape of the thing matters: a draft to approve, facts in
labelled rows, a short form, a list with a control on each row. A sentence is
still a sentence — send `{"type":"text"}` for that.

## The send

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
            { "id": "root", "component": "Column", "children": ["title"] },
            { "id": "title", "component": "Text", "text": "Draft reply" }
          ],
          "dataModel": {}
        }
      }
    ]
  }
}
```

- `surfaceId` is yours to name and is how you reach this card again. Letters,
  digits, dot, underscore and dash, up to 128 characters. Name it for the thing
  — `draft-nick-retainer`, not `card1`.
- **One send is one surface.** Every message in `messages` repeats the same
  `surfaceId`; a send whose messages wander is refused whole.
- Every message is an envelope: `"version": "v1.0"` and exactly one of the four
  message keys below. Nothing else at that level.
- A card does not end your Turn — it is something you put in the thread, not a
  question you are waiting on. `disposition` still decides: `"continue"` while
  you have more to do, `"finish"` on the send that ends the reply.

## The four messages

| Message            | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `createSurface`    | Replaces the whole surface: its components, its data model, its properties. |
| `updateComponents` | Upserts components by `id`, keeping the order they were first seen in.      |
| `updateDataModel`  | Writes `value` at a JSON Pointer `path`; no `path` writes the whole model.  |
| `deleteSurface`    | Withdraws the card. It stays in the transcript saying it was withdrawn.     |

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

Spell it the 1.0 way: `version` is `"v1.0"`, and a surface's own properties are
`surfaceProperties`. `createSurface` takes `surfaceId`, and optionally
`components`, `dataModel`, `surfaceProperties`, `catalogId` and
`sendDataModel`. You never need `catalogId`: the app registers one catalog
holding every component named in the references, so a bare component name
resolves.

## Components are an adjacency list

A surface is a **flat array** of components. Each one has an `id` and a
`component` name, and a parent names its children **by id** — never inline.

- Exactly one component has `id: "root"`. That is what mounts; a surface with
  no `root` is not drawn.
- An `id` is letters, digits, dot, underscore or dash, up to 128 characters,
  and unique on the surface.
- A container names children with `"children": ["a", "b"]`, or with a template
  (see below). A `Card` and a `Button` name a single `"child"`; a `Modal` names
  a `"trigger"` and a `"content"`.
- A component nobody names is simply not drawn. Nothing warns you — check that
  every id you wrote is reachable from `root`.

## Values, and binding them to the data model

Most properties take either a literal or a **binding** — `{"path": "/pointer"}`
— which reads that place in the data model. The references mark these
"bindable".

```json
{ "id": "subject", "component": "Text", "text": { "path": "/subject" } }
```

- A `path` is an RFC 6901 JSON Pointer against the data model: `/subject`,
  `/rows/0/label`. An empty path is the whole model.
- Bind what changes; write a literal for what does not. A card whose layout is
  fixed and whose values move costs one small `updateDataModel` to change,
  instead of a whole new component set.
- **Template rows.** A container can generate children from a list:
  `"children": {"componentId": "row", "path": "/items"}` draws the component
  `row` once per entry in `/items`, and inside it a relative-looking pointer
  still resolves against the whole model, so give each row's fields their own
  paths under `/items`. Keep the template component out of any other
  `children` array.
- `null` at a pointer deletes that member.

## What a press does

A control carries an `action`, and its **name** is what decides what the press
means. The name belongs to the kernel, not to the card.

```json
{
  "id": "send",
  "component": "Button",
  "child": "sendLabel",
  "action": {
    "event": {
      "name": "approval/appr-7f2",
      "context": { "decision": "approve" }
    }
  }
}
```

| Name                         | What happens                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `approval/<approvalId>`      | Decides an Approval that was already recorded: durable, once, ending the Turn that asked.                                 |
| `plugin/<pluginId>/<action>` | Calls that Plugin's handler, which answers with messages that update the card. No Turn is spent.                          |
| anything else                | Arrives as your next Turn's input: the name and its context, as something the card raised — never as words the User said. |

**You cannot invent an `approvalId`.** An id the kernel never issued is refused
when the button is pressed. To put an approval on a card, send the approval
first, in the same reply, and use `ApprovalActions` with that same id:

1. `{"type":"card", …}` with an `ApprovalActions` component carrying
   `"approvalId": "appr-7f2"` — the host draws both buttons and mints the
   action names itself, so you write no `action` for it.
2. An `approval` send carrying that same id, with `disposition: "finish"`.
   That is what records the decision the card's buttons decide, and it ends
   your Turn.

   ```json
   {
     "type": "approval",
     "approvalId": "appr-7f2",
     "action": "Send the reply to nick@example.com",
     "risk": "medium"
   }
   ```

The decision reaches you as input on a later Turn. Then update the card in
place to its settled state.

Everything else you want a press to reach is a name of your own — `pick-option`,
`retry` — and it comes back to you as input. Put what you need to tell two
presses apart in the action's `context`.

## Updating a card, and settling it

Send `card` again with the **same `surfaceId`**. Change the values with
`updateDataModel`, change the shape with `updateComponents`, and use
`createSurface` again only when the card genuinely becomes a different thing.

When the thing is done, the card does not disappear — it **settles**. Replace
the controls with a `Receipt`: the same title, a pill saying what happened, and
one line summarising it ("Sent to nick@example.com — Re: Following up"). A
`StatusPill` bound to the data model settles the same way with one
`updateDataModel`. Never leave a card offering a button for something already
done.

## The budgets

Per surface: **128 components**, **32 actions**, **16,000 bytes of data
model**. Per send: **16 messages**, **32,000 bytes each**. Per conversation:
**32 cards** — past that the oldest card is withdrawn to make room for the new
one, so do not draw a card for something a sentence would carry.

A card is a thing with controls, not a page. If a card needs half those
budgets, it has stopped being a card.

## What is refused

A surface is refused **whole** — never drawn with a hole in it — and the User
sees an unavailable region where your card would be, saying why. The causes:

- a component name no catalog declares, or a property it does not have;
- a `url` that is not `https://`;
- no `root`, a duplicate `id`, or an `id` that is not well formed;
- anything past a budget above;
- an envelope that is not `"v1.0"` with exactly one message key.

A refusal is your mistake, not the User's. Read the reference for the family
you are composing before you write it, rather than guessing a property name.

## References

Load one with `skill_load` — `{"path": "managed/a2ui", "reference": "forms.md"}`.

- `layout.md` — `Row`, `Column`, `List`, `Card`, `Tabs`, `Divider`, `Modal`.
- `text-and-media.md` — `Text`, `Image`, `Icon`, `Video`, `AudioPlayer`.
- `forms.md` — `TextField`, `CheckBox`, `DateTimeInput`, `ChoicePicker`,
  `Slider`, and the validation and formatting functions.
- `actions.md` — `Button`, the action shape, `sendDataModel`, and the kernel's
  action namespaces.
- `frock.md` — FrockBot's own core components: `StatusPill`, `KeyValueRows`,
  `CollapsibleText`, `ApprovalActions`, `Receipt`.
- `structure.md` — the frame: `CardHeader`, `SectionHeader`, `Callout`,
  `IdentityRow`.
- `data.md` — numbers and rows: `MetricTile`, `ProgressBar`, `DataTable`,
  `Timeline`.
- `rich-text.md` — words: `Markdown`, `CodeBlock`, `Quote`.
- `media.md` — pictures, files and links: `ImageGallery`, `FileAttachment`,
  `LinkPreview`.
- `input.md` — answers: `ChoiceChips`, `MultiSelect`, `SegmentedControl`,
  `Rating`.
- `examples.md` — three complete cards, end to end.

Start with `frock.md` and `structure.md`: most cards are a `CardHeader` and a
Frock component or two inside a `Column`, and the standard catalog only for
the rest.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends your
reply.
