---
name: Build an Applet
description: Use this whenever you are creating or changing an Applet — a small real-time app with its own data, its own page beside the conversation, and tools you can call. It is the reference for the Applets SDK, the file layout, the authoring tools, and every rule the linter enforces.
---

# Build an Applet

An Applet is a real application. It has its own SQLite storage that survives
every code change, a React page the User opens beside this conversation, and
tools you — and the Bots you share it with — can call. You write it in
TypeScript with the `applet_*` tools, check it, and publish it. The source
lives in the cloud, a build service compiles it, and the published code runs in
the kernel's loader — no Computer is involved at any point.

## Who may do what

Every Applet has exactly one owner Bot. The Applets you create are yours.

- **The owner** reads and writes the source, checks, publishes, reverts, reads
  the generations, deletes, shares, unshares and transfers.
- **A Bot it is shared with** can see it in `applet_list`, open or focus it,
  send it as a chat card and call its published tools — nothing else. Reading
  its source, publishing over it or deleting it is refused. If it needs a
  change, ask the Bot that owns it with `bot_message`.
- `applet_list` says which is which: `yours`, or `shared with you by <bot>`.

Sharing is the owner's call:

- **`applet_share`** with the Applet's id and another Bot's id from
  `<teammates>` lets that Bot use it. The Bot must be active.
- **`applet_unshare`** takes that away. Its tools leave the other Bot from its
  next Turn; a Turn it is already running keeps them until it ends.
- **`applet_transfer`** makes another active Bot the owner. You keep shared
  access, and from then on only the new owner can change it. The source, the
  generations and the data do not move. Transfer only when the User asks.

Tool names are unique across the whole account, not just across the Applets
you can see, so a publish can be refused for a name you have never seen used.
Rename the tool and publish again.

If the owner Bot is archived, its Applets are unavailable to every Bot until it
is restored, and nothing is lost. If the owner Bot is deleted, its Applets are
deleted too, including for the Bots they were shared with.

Two files are yours: `server.ts` (the tables and the tools) and `ui.tsx` (the
page). Nothing else.

## The loop

1. **`applet_create`** with a display name. It makes an Applet you own,
   scaffolds a working todo list, and puts it in the panel beside the
   conversation. Do not create a second Applet for a change to one you already
   own — `applet_list` first. An Applet shared with you is not yours to change;
   ask its owner rather than building a copy.
2. **`applet_files`** and **`applet_read_file`** to see what is there, then
   **`applet_write_file`** to change it. A write replaces the whole file, so
   read before you write. Two files are yours: `server.ts` and `ui.tsx`. The
   scaffold already builds; change it rather than starting empty.
3. **`applet_check`** with the Applet's id. It type-checks, lints, bundles and
   boots your server, and answers either with every problem as
   `path:line:col message` or with the tools it declares and a URL for its
   page. Fix every diagnostic. Do not publish over a failing check — the
   publish is refused and returns the same lines.
4. **`applet_publish`** with the Applet's id. It builds the current source
   again, records an immutable generation, mounts it, and offers its tools to
   you and every Bot it is shared with from the next Turn — not this one.

The tool list is derived by _running_ your server inside the build, so a tool
that does not boot is a build failure rather than a surprise later.

`applet_check`'s page URL is the built UI with no data behind it: it proves
the page renders, not that the Applet works. Publishing is what makes it real.

`applet_generations` lists the history; `applet_revert` moves back to an
earlier generation and is itself recorded. Reverting code never touches the
Applet's data. `applet_delete` destroys the data too — for every Bot it is
shared with — so ask the User first.

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

Every one of these is an error from `applet_check`, not a warning.

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

| What you see                                | What it means                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `the build failed at the typecheck stage`   | fix every `path:line:col` line it returned before doing anything else                                                                            |
| `the build failed at the lint stage`        | a rule below was broken; the message names which                                                                                                 |
| `the build failed at the describe stage`    | your server threw while booting, so its tools could not be read                                                                                  |
| `the build failed at the bundle stage`      | your code could not be bundled, usually an import that does not resolve; but a message about the Workers runtime not starting is nothing you did |
| `<appletId> has no source`                  | you are publishing an Applet you never scaffolded; call `applet_create`                                                                          |
| `the build service is unavailable`          | nothing you did; say so to the User rather than retrying in a loop                                                                               |
| a publish reports `failed` with diagnostics | the generation did not mount; the previous one is still live and its data is untouched                                                           |
| the tools do not appear                     | a published generation activates on your **next** Turn, not the one that published it                                                            |
| `only the Bot that owns it can change it`   | the Applet is shared with you; ask its owner with `bot_message`                                                                                  |
| `Applet "…" is unavailable`                 | it was deleted, unshared from you, or its owner Bot is archived                                                                                  |

Report a publish failure to the User with the diagnostics as they were
printed. Never claim an Applet is working because the build passed: publishing
is what makes it real, and only a `published` result means it did.
