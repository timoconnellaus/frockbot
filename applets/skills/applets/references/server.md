# `server.ts`

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
