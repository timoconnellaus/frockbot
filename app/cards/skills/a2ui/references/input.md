# Input

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

`forms.md` has the standard controls — `TextField`, `CheckBox`, `Slider`,
`DateTimeInput`, `ChoicePicker`. These four are the answers a chat card
actually asks for, and each of them built out of `CheckBox`es would cost a
component per option and read like a form.

- **`ChoiceChips`** — pick one of a handful, as chips that wrap: a tone, a
  recipient, one of the dates you suggested. `ChoicePicker` is the drop-down
  for a long list.
- **`MultiSelect`** — tick any number of a handful. The ticked values are a
  list in the data model.
- **`SegmentedControl`** — two, three or four things always visible: a view, a
  mode, a period.
- **`Rating`** — stars, for asking how good it was, or — with `readOnly` — for
  showing a rating already recorded.

## Every control writes to the data model

Write a **binding** for `value` (or `values`), never a literal:

```json
{
  "id": "tone",
  "component": "ChoiceChips",
  "value": { "path": "/tone" },
  "options": [
    { "label": "Warm", "value": "warm" },
    { "label": "Brief", "value": "brief" },
    { "label": "Formal", "value": "formal" }
  ]
}
```

That matters because of how an answer reaches you: a press carries the
renderer's data model back with it when the surface asked for it, and what a
control kept to itself is never in that model. So:

1. Put `"sendDataModel": true` on the `createSurface` of any card you want an
   answer from.
2. Seed the data model with what starts chosen —
   `"dataModel": {"tone": "warm", "include": ["invoice"]}` — and the controls
   draw that way.
3. Give the card something to press: a `Button` with an action name of your
   own, or `ApprovalActions` when the answer is a decision. The press brings
   the whole model with it.

Use a control's own `action` only when choosing _is_ the whole answer —
picking one of three dates — because it raises a press the instant a chip is
tapped, and a person who is still making up their mind will send you two.

## What the host does without being asked

- `MultiSelect`'s list comes back in the **order the options were declared**,
  not the order they were ticked, so what you read is the shape you wrote.
- Past `maxSelected`, the unticked options stop responding rather than
  quietly untick an earlier choice.
- `SegmentedControl` draws the first segment as chosen when the data model
  holds nothing, because a segmented control with nothing lit reads as broken.
- Tapping the star that is already the rating clears it, which is the only way
  back to no rating.

## Components

### `ChoiceChips`

Pick one of a handful of options, laid out as chips that wrap. For a short, visible set — a tone, a recipient, a date the Bot suggested. Use ChoicePicker for a long list.

| Property  | Type                                      | Required | Binding                        | What it is                                                                                                                                                                                    |
| --------- | ----------------------------------------- | -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options` | array of { label: string, value: string } | yes      | literal                        | What can be picked, in the order shown.                                                                                                                                                       |
| `value`   | DynamicString                             | yes      | bindable                       | Where the pick is kept: write a binding, `{"path": "/tone"}`. It must be a binding — a press carries the data model back, and a selection the component kept to itself would never reach you. |
| `action`  | Action                                    | no       | `{ event: { name, context } }` | Raised as soon as a chip is picked, when picking is the whole answer. Leave it out when a Button below submits the card.                                                                      |

```json
{
  "id": "root",
  "component": "ChoiceChips",
  "options": [
    {
      "label": "…label…",
      "value": "…value…"
    }
  ],
  "value": "…value…"
}
```

### `MultiSelect`

Tick any number of a handful of options. The ticked values are kept as a list in the data model, in the order the options are declared.

| Property      | Type                                                       | Required | Binding  | What it is                                                                                                                      |
| ------------- | ---------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `options`     | array of { label: string, value: string, detail?: string } | yes      | literal  | What can be ticked, in the order shown.                                                                                         |
| `values`      | DynamicStringList                                          | yes      | bindable | Where the ticked values are kept: write a binding, `{"path": "/include"}`. Seed the data model with the ones that start ticked. |
| `maxSelected` | integer                                                    | no       | literal  | How many may be ticked at once. Past it the unticked options stop responding and the host says why. Unbounded by default.       |

```json
{
  "id": "root",
  "component": "MultiSelect",
  "options": [
    {
      "label": "…label…",
      "value": "…value…"
    }
  ],
  "values": []
}
```

### `SegmentedControl`

Choose between two, three or four things that are always visible — a view, a mode, a period. Not for an answer with many options: that is ChoiceChips.

| Property  | Type                                      | Required | Binding                        | What it is                                                                                                         |
| --------- | ----------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `options` | array of { label: string, value: string } | yes      | literal                        | The segments, left to right.                                                                                       |
| `value`   | DynamicString                             | yes      | bindable                       | Where the choice is kept: write a binding. The first segment is drawn as chosen when the data model holds nothing. |
| `action`  | Action                                    | no       | `{ event: { name, context } }` | Raised when a segment is chosen. Leave it out when the choice only changes what the card shows.                    |

```json
{
  "id": "root",
  "component": "SegmentedControl",
  "options": [
    {
      "label": "…label…",
      "value": "…value…"
    }
  ],
  "value": "…value…"
}
```

### `Rating`

How good was it, in stars. For asking, and — with readOnly — for showing a rating that is already recorded.

| Property   | Type          | Required | Binding  | What it is                                                                                            |
| ---------- | ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `value`    | DynamicNumber | yes      | bindable | How many stars, from 0. Write a binding when you are asking; a literal is fine when readOnly is true. |
| `max`      | integer       | no       | literal  | How many stars there are. Defaults to 5.                                                              |
| `label`    | string        | no       | literal  | What is being rated, drawn above the stars.                                                           |
| `readOnly` | boolean       | no       | literal  | True shows a rating rather than asking for one. Defaults to false.                                    |

```json
{
  "id": "root",
  "component": "Rating",
  "value": 0
}
```
