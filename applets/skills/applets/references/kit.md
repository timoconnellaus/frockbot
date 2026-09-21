# The component kit

`import { … } from "@frockbot/applet-sdk/kit"`. Fourteen components; they are
the whole visual vocabulary. There is no CSS file to write and no colour to
choose.

| Component           | Props that matter                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Stack`             | `direction` `"row" \| "column"`, `gap` `"none" \| "small" \| "medium" \| "large"`, `align`, `justify`, `wrap`, `root` (exactly one, at the top) |
| `Text`              | `size` `"title" \| "heading" \| "body" \| "small"`, `tone` `"default" \| "muted"`, `as`                                                         |
| `Button`            | `variant` `"default" \| "primary" \| "ghost"`, `onClick`, `disabled`. Never submits a form by accident.                                         |
| `Input`, `Textarea` | `label`, `error`, `value`, `onValueChange(value)`, `placeholder`; native attributes pass through                                                |
| `Select`            | `Input` plus `options: Array<{ value; label }>`                                                                                                 |
| `Checkbox`          | `checked`, `onChange(checked)`, `label` or `ariaLabel` (one is required), `disabled`                                                            |
| `Card`              | `title?`, children — a bordered panel                                                                                                           |
| `Toolbar`           | children lead, `end?` trails — the Applet's title and its status or primary action                                                              |
| `List`, `ListItem`  | `List`: `bordered?` (default true). `ListItem`: `start?`, `end?`, `onClick?`, children                                                          |
| `Badge`             | `tone` `"default" \| "accent"`                                                                                                                  |
| `EmptyState`        | `title`, `description?`, `action?` — show it whenever a live query is empty                                                                     |
| `Dialog`            | `open`, `onClose` (Escape and backdrop), `title`, `actions`                                                                                     |

The kit reads the nine tokens the host injects: `surface`, `surface-raised`,
`surface-subtle`, `text`, `text-muted`, `border`, `accent-surface`,
`accent-text`, `radius-card`. Read them yourself only as
`var(--frockbot-<name>)`.
