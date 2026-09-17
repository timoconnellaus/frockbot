# Data display

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

`KeyValueRows` (`frock.md`) answers "what are the facts about this one thing".
These four are the other shapes a card's content comes in.

- **`MetricTile`** — one number that matters, with its name and how it moved.
  Two or three in a `Row` is a summary. Six is a table.
- **`ProgressBar`** — a proportion: how far through, how much of a budget.
  Bind `value` and the bar moves with one `updateDataModel`.
- **`DataTable`** — rows in aligned columns: line items, search results, a
  comparison. **Never compose a table out of `Row`s** — the columns will not
  line up between rows, and it costs a component per cell.
- **`Timeline`** — what happened, in order: the steps of a run, the history of
  a thread. For events with a time, not for a list of things.

## Numbers are yours to format

The host draws what you write. `"$4,120"`, `"18%"`, `"3 of 7"` — do the
rounding, the currency and the thousands separators yourself, and write the
number the way the person reads it. There is no formatting function that will
do it later.

`MetricTile`'s `delta` is the exception with a rule: start it with `+` or `-`
and the host draws the arrow. Which direction is _good_ is yours to say in
`tone`, because a falling error count is a rise.

## A table fits the card

Five columns at most, twenty-four rows at most, and the columns share the
card's width. **Three columns is what fits a phone.** Past that — or with a
heavy `weight` on one of them — the table becomes a sideways scroller rather
than squeezing a column narrower than the values in it, which is a table the
person has to drag to read. So:

- give a numeric column `"align": "end"`;
- give the column that carries the long text a bigger `weight`, and remember
  that the weight is what pushes the others towards the scrolling case;
- prefer three columns; put the fourth fact in the row's own first cell, or in
  a `Timeline` entry's `detail`;
- when there are more rows than fit, send the first few and say so in
  `caption`: `"Showing 12 of 340"`.

A row with fewer cells than there are columns is padded; a row with more loses
the extra. The columns line up either way.

```json
{
  "id": "items",
  "component": "DataTable",
  "columns": [
    { "label": "Item", "weight": 3 },
    { "label": "Qty", "align": "end" },
    { "label": "Amount", "align": "end" }
  ],
  "rows": [
    { "cells": ["Retainer — September", "1", "$4,000"] },
    { "cells": ["Scope change", "2", "$1,200"] }
  ],
  "caption": "Showing 2 of 2 line items"
}
```

Every cell is bindable, so a table whose values move costs one
`updateDataModel` against `/rows/0/cells/2` rather than a new component set.

## Components

<!-- components: MetricTile, ProgressBar, DataTable, Timeline -->
