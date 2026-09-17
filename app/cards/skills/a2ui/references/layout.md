# Layout

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

Reach for these to arrange what a card already says. Almost every card is a
`Column` at `root` with three or four children: a title, the thing, the
controls. `Row` puts two things side by side — a title and a `StatusPill`, a
pair of buttons. `Card` draws a bordered block inside the card when one part
needs to look separate from the rest, and `List` is for repeated rows,
especially with a template.

Two rules that catch people out:

- **Children are ids.** `"children": ["title", "body"]` names components that
  are elsewhere in the same flat array. There is no nesting.
- **`Card` and `Modal` take single children.** `Card` has one `child`, so wrap
  several things in a `Column` first. `Modal` names a `trigger` (usually a
  `Button`) and a `content`.

`weight` is how a child divides the space of the `Row` or `Column` it sits
directly in — like CSS `flex-grow`. It means nothing anywhere else.

Prefer a shallow card. Two levels of container is usually enough, and every
level costs a component out of the 128 a surface may hold.

## Components

### `Row`

A layout component that arranges its children horizontally. To create a grid layout, nest Columns within this Row.

| Property   | Type                                                                                          | Required | Binding            | What it is                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `children` | ChildList                                                                                     | yes      | ids, or a template | Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list. Children cannot be defined inline, they must be referred to by ID. |
| `justify`  | `center` \| `end` \| `spaceAround` \| `spaceBetween` \| `spaceEvenly` \| `start` \| `stretch` | no       | literal            | Defines the arrangement of children along the main axis (horizontally). Use 'spaceBetween' to push items to the edges, or 'start'/'end'/'center' to pack them together. Defaults to `"start"`.            |
| `align`    | `start` \| `center` \| `end` \| `stretch`                                                     | no       | literal            | Defines the alignment of children along the cross axis (vertically). This is similar to the CSS 'align-items' property, but uses camelCase values (e.g., 'start'). Defaults to `"stretch"`.               |
| `weight`   | number                                                                                        | no       | literal            | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                                                                                    |

```json
{
  "id": "root",
  "component": "Row",
  "children": ["body"]
}
```

### `Column`

A layout component that arranges its children vertically. To create a grid layout, nest Rows within this Column.

| Property   | Type                                                                                          | Required | Binding            | What it is                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `children` | ChildList                                                                                     | yes      | ids, or a template | Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list. Children cannot be defined inline, they must be referred to by ID.                           |
| `justify`  | `start` \| `center` \| `end` \| `spaceBetween` \| `spaceAround` \| `spaceEvenly` \| `stretch` | no       | literal            | Defines the arrangement of children along the main axis (vertically). Use 'spaceBetween' to push items to the edges (e.g. header at top, footer at bottom), or 'start'/'end'/'center' to pack them together. Defaults to `"start"`. |
| `align`    | `center` \| `end` \| `start` \| `stretch`                                                     | no       | literal            | Defines the alignment of children along the cross axis (horizontally). This is similar to the CSS 'align-items' property. Defaults to `"stretch"`.                                                                                  |
| `weight`   | number                                                                                        | no       | literal            | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                                                                                                              |

```json
{
  "id": "root",
  "component": "Column",
  "children": ["body"]
}
```

### `List`

| Property    | Type                                      | Required | Binding            | What it is                                                                                                                             |
| ----------- | ----------------------------------------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `children`  | ChildList                                 | yes      | ids, or a template | Defines the children. Use an array of strings for a fixed set of children, or a template object to generate children from a data list. |
| `direction` | `vertical` \| `horizontal`                | no       | literal            | The direction in which the list items are laid out. Defaults to `"vertical"`.                                                          |
| `align`     | `start` \| `center` \| `end` \| `stretch` | no       | literal            | Defines the alignment of children along the cross axis. Defaults to `"stretch"`.                                                       |
| `weight`    | number                                    | no       | literal            | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                 |

```json
{
  "id": "root",
  "component": "List",
  "children": ["body"]
}
```

### `Card`

| Property | Type        | Required | Binding                  | What it is                                                                                                                                                                                                                                         |
| -------- | ----------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child`  | ComponentId | yes      | another component's `id` | The ID of the single child component to be rendered inside the card. To display multiple elements, you MUST wrap them in a layout component (like Column or Row) and pass that container's ID here. Do NOT pass multiple IDs or a non-existent ID. |
| `weight` | number      | no       | literal                  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                                                                                                                             |

```json
{
  "id": "root",
  "component": "Card",
  "child": "body"
}
```

### `Tabs`

| Property | Type                                                  | Required | Binding                       | What it is                                                                               |
| -------- | ----------------------------------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `tabs`   | array of { title: DynamicString, child: ComponentId } | yes      | literal rows; values bindable | An array of objects, where each object defines a tab with a title and a child component. |
| `weight` | number                                                | no       | literal                       | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.   |

```json
{
  "id": "root",
  "component": "Tabs",
  "tabs": [
    {
      "title": "…title…",
      "child": "body"
    }
  ]
}
```

### `Divider`

| Property | Type                       | Required | Binding | What it is                                                                             |
| -------- | -------------------------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `axis`   | `horizontal` \| `vertical` | no       | literal | The orientation of the divider. Defaults to `"horizontal"`.                            |
| `weight` | number                     | no       | literal | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one. |

```json
{
  "id": "root",
  "component": "Divider"
}
```

### `Modal`

| Property  | Type        | Required | Binding                  | What it is                                                                             |
| --------- | ----------- | -------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `trigger` | ComponentId | yes      | another component's `id` | The ID of the component that opens the modal when interacted with (e.g., a button).    |
| `content` | ComponentId | yes      | another component's `id` | The ID of the component to be displayed inside the modal.                              |
| `weight`  | number      | no       | literal                  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one. |

```json
{
  "id": "root",
  "component": "Modal",
  "trigger": "body",
  "content": "body"
}
```

## Template children

Any container whose `children` is a `ChildList` accepts a template instead of
an array of ids:

```json
{
  "id": "rows",
  "component": "Column",
  "children": { "componentId": "rowTemplate", "path": "/items" }
}
```

`path` is a JSON Pointer to a list in the data model, and `componentId` names
the component drawn once per entry. Bind the template's own properties to the
entries — `{"path": "/items/0/label"}` shows the shape the renderer resolves
per row. Keep the template component out of every other `children` array: it is
a pattern, not a child.
