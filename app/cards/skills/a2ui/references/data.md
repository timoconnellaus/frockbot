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
card's width — they do not scroll sideways. So:

- give a numeric column `"align": "end"`;
- give the column that carries the long text a bigger `weight`;
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

### `MetricTile`

One number that matters, with its name under it and an optional movement beside it. Put two or three in a Row for a summary; a Row of six is a table, so use DataTable instead.

| Property  | Type                                                       | Required | Binding  | What it is                                                                                            |
| --------- | ---------------------------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `label`   | string                                                     | yes      | literal  | What the number is, e.g. 'Open invoices'.                                                             |
| `value`   | DynamicString                                              | yes      | bindable | The number itself, already formatted the way a person reads it: '$4,120', '18%', '3 of 7'.            |
| `delta`   | DynamicString                                              | no       | bindable | How it moved, e.g. '+12%' or '-3 since Friday'. The host draws an arrow from the sign it starts with. |
| `caption` | DynamicString                                              | no       | bindable | One quiet line under the tile: the period, the source.                                                |
| `tone`    | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What the number means — not which way it moved. Defaults to 'neutral'.                                |

```json
{
  "id": "root",
  "component": "MetricTile",
  "label": "…label…",
  "value": "…value…"
}
```

### `ProgressBar`

A proportion: how far through something is, how much of a budget is used. For work that is running, not for a rating.

| Property        | Type                                                       | Required | Binding  | What it is                                                                                             |
| --------------- | ---------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `value`         | DynamicNumber                                              | yes      | bindable | Between 0 and 1. Anything outside that is clamped. Bind it and the bar moves with one updateDataModel. |
| `label`         | DynamicString                                              | no       | bindable | What is progressing, above the bar.                                                                    |
| `caption`       | DynamicString                                              | no       | bindable | The count in words, at the right of the label: '3 of 7', '62%'.                                        |
| `tone`          | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What the host colours the filled part. Defaults to 'ready' while something is running.                 |
| `indeterminate` | boolean                                                    | no       | literal  | True when the proportion is not known yet: the bar animates instead of filling. Defaults to false.     |

```json
{
  "id": "root",
  "component": "ProgressBar",
  "value": 0
}
```

### `DataTable`

Rows in aligned columns: line items, search results, a comparison. The host lays the columns out so they fit the card at phone width — never compose a table out of Rows.

| Property  | Type                                                                   | Required | Binding | What it is                                                                                                               |
| --------- | ---------------------------------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `columns` | array of { label: string, align?: `start` \| `end`, weight?: integer } | yes      | literal | The columns, left to right. Five at most: a card is not a spreadsheet.                                                   |
| `rows`    | array of { cells: array of DynamicString }                             | yes      | literal | The rows, in the order they are read. A row has one cell per column; a short row is padded, and extra cells are dropped. |
| `caption` | string                                                                 | no       | literal | One line under the table, e.g. 'Showing the 12 most recent of 340'. Say so here when the rows are a sample.              |

```json
{
  "id": "root",
  "component": "DataTable",
  "columns": [
    {
      "label": "…label…"
    }
  ],
  "rows": [
    {
      "cells": ["…cells…"]
    }
  ]
}
```

### `Timeline`

What happened, in order, down a rail: the steps of a run, the history of a thread, what a Routine did overnight. For events with a time, not for a list of things.

| Property  | Type                                                                                                                                        | Required | Binding                       | What it is                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- | -------------------------------------------------------- |
| `entries` | array of { title: DynamicString, detail?: DynamicString, time?: string, tone?: `neutral` \| `ready` \| `success` \| `warning` \| `danger` } | yes      | literal rows; values bindable | The events, oldest first unless the card says otherwise. |

```json
{
  "id": "root",
  "component": "Timeline",
  "entries": [
    {
      "title": "…title…"
    }
  ]
}
```
