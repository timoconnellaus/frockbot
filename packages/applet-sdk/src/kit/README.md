# The Applet component kit

`import { … } from "@frockbot/applet-sdk/kit"`

Fourteen components. They are the whole visual vocabulary of an Applet: there
is no CSS file to write and no colour to choose. Every surface, edge, and
accent resolves through the nine semantic tokens the host injects, so an Applet
follows the User's theme — light, dark, or anything FrockBot ships later —
without knowing which one is on.

**Do not** write `#hex`, `rgb(...)`, `hsl(...)`, or a colour name anywhere. The
linter rejects them in `.ts`, `.tsx`, and `.css` alike. If a component cannot
express what you want, the kit is missing something — say so rather than
styling around it.

## Layout

### `Stack`

The only layout primitive. Rows and columns, nothing else.

| Prop        | Type                                          | Default    |
| ----------- | --------------------------------------------- | ---------- |
| `direction` | `"row" \| "column"`                           | `"column"` |
| `gap`       | `"none" \| "small" \| "medium" \| "large"`    | `"medium"` |
| `align`     | `"start" \| "center" \| "end" \| "stretch"`   | —          |
| `justify`   | `"start" \| "center" \| "end" \| "between"`   | —          |
| `wrap`      | `boolean`                                     | `false`    |
| `root`      | `boolean` — put exactly one at the page's top | `false`    |

```tsx
<Stack root gap="large">
  <Stack direction="row" gap="small" align="end">
    …
  </Stack>
</Stack>
```

### `Text`

| Prop   | Type                                             | Default     |
| ------ | ------------------------------------------------ | ----------- |
| `size` | `"title" \| "heading" \| "body" \| "small"`      | `"body"`    |
| `tone` | `"default" \| "muted"`                           | `"default"` |
| `as`   | `"p" \| "span" \| "div" \| "h1" \| "h2" \| "h3"` | `"p"`       |

## Controls

### `Button`

| Prop       | Type                                | Default     |
| ---------- | ----------------------------------- | ----------- |
| `variant`  | `"default" \| "primary" \| "ghost"` | `"default"` |
| `onClick`  | `() => void`                        | —           |
| `disabled` | `boolean`                           | `false`     |

Also accepts the ordinary `<button>` attributes except `className` and `style`.
`type` defaults to `"button"`, so it never submits a form by accident.

### `Input`, `Textarea`

| Prop            | Type                      | Notes                                |
| --------------- | ------------------------- | ------------------------------------ |
| `label`         | `string`                  | rendered above the control           |
| `error`         | `string`                  | rendered below, in the accent colour |
| `value`         | `string`                  | controlled                           |
| `onValueChange` | `(value: string) => void` | receives the value, not the event    |
| `placeholder`   | `string`                  |                                      |

`onKeyDown`, `disabled`, and the rest of the native attributes pass through.

### `Select`

Adds `options: Array<{ value: string; label: string }>`; otherwise identical to
`Input`.

### `Checkbox`

| Prop        | Type                         | Notes                             |
| ----------- | ---------------------------- | --------------------------------- |
| `checked`   | `boolean`                    | required                          |
| `onChange`  | `(checked: boolean) => void` | required                          |
| `label`     | `ReactNode`                  | optional visible label            |
| `ariaLabel` | `string`                     | required when there is no `label` |
| `disabled`  | `boolean`                    |                                   |

## Surfaces

### `Card`

`title?: ReactNode`, plus children. A bordered panel.

### `Toolbar`

`children` sit at the leading edge; `end?: ReactNode` is pushed to the trailing
edge. Use it for the Applet's title and its status or primary action.

### `List` and `ListItem`

`List` takes `bordered?: boolean` (default `true`) and `ListItem` children.

`ListItem`: `start?: ReactNode` (a checkbox, a badge), `end?: ReactNode`
(actions), `onClick?: () => void` (makes the row interactive), and children as
the body.

### `Badge`

`tone?: "default" | "accent"`, plus children.

### `EmptyState`

`title: string`, `description?: string`, `action?: ReactNode`. Show it whenever
a live query comes back empty — an Applet should never render a blank page.

### `Dialog`

| Prop      | Type         | Notes                                     |
| --------- | ------------ | ----------------------------------------- |
| `open`    | `boolean`    | renders nothing when false                |
| `onClose` | `() => void` | fires on Escape and on a backdrop click   |
| `title`   | `ReactNode`  | also becomes the dialog's accessible name |
| `actions` | `ReactNode`  | a trailing row, usually two `Button`s     |

## The nine tokens

The host re-emits these into the page on `init`; the kit reads them and so may
you, always through `var(--frockbot-<name>)`:

`surface`, `surface-raised`, `surface-subtle`, `text`, `text-muted`, `border`,
`accent-surface`, `accent-text`, `radius-card`.
