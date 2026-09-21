# `ui.tsx`

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
