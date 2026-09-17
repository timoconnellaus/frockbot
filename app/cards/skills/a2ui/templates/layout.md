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

<!-- components: Row, Column, List, Card, Tabs, Divider, Modal -->

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
