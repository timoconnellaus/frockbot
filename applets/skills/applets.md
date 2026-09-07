---
name: Build an Applet
description: Use this whenever you are creating or changing an Applet — a small real-time app with its own data, its own page beside the conversation, and tools you can call. It is the reference for the Applets SDK, the file layout, the CLI, and every rule the linter enforces.
---

# Build an Applet

An Applet is a real application. It has its own SQLite storage that survives
every code change, a React page the User opens beside this conversation, and
tools every Bot of this User can call. You write it in TypeScript on the
Computer, check it, build it, and publish it; the published code runs in the
kernel's loader, never on the Computer.

Two files are yours: `server.ts` (the tables and the tools) and `ui.tsx` (the
page). Nothing else.

## The loop

1. **`applet_create`** with a display name. It makes the Applet, scaffolds a
   working todo list into
   `/home/box/agent-data/user-packages/applets/source/<appletId>/`, and puts it
   in the panel beside the conversation. Do not create a second Applet for a
   change to an existing one — `applet_list` first.
2. **Edit** `server.ts` and `ui.tsx` in that directory with the ordinary file
   tools. The scaffold already builds; change it rather than starting empty.
3. **`applet check`** in that directory. It type-checks and lints, and prints
   every problem as `path:line:col message`. Fix all of them. Do not publish
   over a failing check — the publish will be refused and you will have spent a
   Turn learning what `applet check` would have told you.
4. **`applet build`** in that directory. It writes `dist/server.js`,
   `dist/ui.html`, and `dist/manifest.json`. The tool list in the manifest is
   derived by _running_ your server, so a tool that does not boot is a build
   failure, not a surprise later.
5. **`applet dev`** if you want to look at it. It prints a local URL and opens
   nothing; open that URL in the Computer's browser and screenshot it. Models
   are unavailable in `applet dev`.
6. **`applet_publish`** with the Applet's id. It reads what `applet build`
   wrote, records an immutable generation, mounts it, and offers its tools to
   every Bot of this User from your next Turn — not this one.

`applet_generations` lists the history; `applet_revert` moves back to an
earlier generation and is itself recorded. Reverting code never touches the
Applet's data. `applet_delete` destroys the data too, so ask the User first.

## `server.ts`

```ts
import { Applet, t, table } from "@frockbot/applet-sdk/server";

const tables = {
  todos: table({
    id: t.id(),
    title: t.text(),
    done: t.boolean().default(false),
    createdAt: t.timestamp(),
  }),
};

export default class TodoApplet extends Applet<typeof tables> {
  tables = tables;

  tools = {
    add_todo: this.tool(
      { description: "Add a todo to the list", input: { title: t.text() } },
      ({ title }) => {
        this.db.todos.insert({ title, createdAt: new Date().toISOString() });
        return `Added "${title}".`;
      },
    ),
  };
}
```

- `tables` must be an object literal of `table({ … })` calls, declared once.
  The schema becomes the SQLite tables, the wire format, and the client's
  collections. Column types: `t.id()`, `t.text()`, `t.boolean()`,
  `t.timestamp()`, each with optional `.default(value)` and `.optional()`.
- `tools` must be an object literal of `this.tool({ description, input }, fn)`
  calls. A tool name is `^[a-z][a-z0-9_]{0,63}$` and the description is what a
  model reads before calling it, so write it for a model.
- `this.db.<table>` is the only way to read or write:
  `insert(values)`, `update(key, patch)`, `delete(key)`, `select(filter?)`.
  Each call is atomic.
- A tool returns a string. That string is what the calling Bot sees.
- **Schema changes.** Adding a column with `.default(…)` or `.optional()` is
  applied on the next mount and the rows are kept. Anything else — a rename, a
  value rewrite — needs `async migrate(from: number)` on the class. It runs
  once, before the Applet serves anything, and throwing fails the activation
  back to the last known-good generation with the old data still resident.

## `ui.tsx`

```tsx
import { useState } from "react";
import { createApplet, mount, newId } from "@frockbot/applet-sdk/client";
import { Button, Input, List, ListItem, Stack } from "@frockbot/applet-sdk/kit";
import type TodoApplet from "./server";

const applet = createApplet<TodoApplet>();

function App() {
  const { data: todos } = applet.useLiveQuery((query) =>
    query
      .from({ todo: applet.tables.todos })
      .orderBy(({ todo }) => todo.createdAt),
  );
  // Optimistic: the row appears at once and rolls back if the server rejects it.
  const add = (title: string) =>
    applet.tables.todos.insert({
      id: newId(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    });
  return (
    <Stack root gap="large">
      …
    </Stack>
  );
}

mount(<App />);
```

- `createApplet<TServer>()` connects on its own when the host sends `init`.
  There is no loading wiring to write and no URL to fetch.
- `applet.useApplet()` gives `{ status }` if you want to show the connection.
- Mutations are per-row and optimistic; a rejection rolls the row back. Do not
  write your own retry.
- Call `mount(<App />)` exactly once, at the bottom of the file.

## The component kit

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

## The rules the linter enforces

Every one of these is an error from `applet check`, not a warning.

- **`applet/no-raw-colors`** — no `#hex`, `rgb()`, `rgba()`, `hsl()`, `hsla()`,
  `color-mix()`, or a CSS colour name, in `.ts`, `.tsx`, or `.css`. Use the
  tokens. If the kit cannot express what you want, say so to the User rather
  than styling around it.
- **`applet/no-network`** — no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, or `navigator.sendBeacon`. An Applet has no outbound network.
  Reach the world through a tool on the server, which the Bot calls.
- **`applet/allowed-imports`** — only relative imports, `react`, and
  `@frockbot/applet-sdk/*`. There is no npm install.
- **`applet/tables-via-table`** — `tables` is an object literal of `table({…})`.
- **`applet/tools-via-this-tool`** — `tools` is an object literal of
  `this.tool(…)`.

## When it goes wrong

| What you see                                        | What it means                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `"dist/server.js" is …: run \`applet build\` …`     | you published without building, or built in the wrong directory                        |
| `dist/manifest.json does not match the built files` | you edited a file after building; run `applet build` again                             |
| `applet check: N error(s)`                          | fix every line it printed before doing anything else                                   |
| a publish reports `failed` with diagnostics         | the generation did not mount; the previous one is still live and its data is untouched |
| the tools do not appear                             | a published generation activates on your **next** Turn, not the one that published it  |

Report a publish failure to the User with the diagnostics as they were
printed. Never claim an Applet is working because the build passed: publishing
is what makes it real, and only a `published` result means it did.
