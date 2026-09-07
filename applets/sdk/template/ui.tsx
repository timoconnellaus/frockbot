import { useState } from "react";
import { createApplet, mount, newId } from "@frockbot/applet-sdk/client";
import {
  Button,
  Checkbox,
  EmptyState,
  Input,
  List,
  ListItem,
  Stack,
  Text,
  Toolbar,
} from "@frockbot/applet-sdk/kit";

import type TodoApplet from "./server";

/**
 * The page half of __APPLET_NAME__.
 *
 * `createApplet` connects when the host sends its `init` message, so there is
 * no loading wiring to write. Every mutation is optimistic: the row appears at
 * once and rolls back on its own if the server rejects it.
 */
const applet = createApplet<TodoApplet>();

function App() {
  const [draft, setDraft] = useState("");
  const { status } = applet.useApplet();
  const { data: todos } = applet.useLiveQuery((query) =>
    query
      .from({ todo: applet.tables.todos })
      .orderBy(({ todo }) => todo.createdAt),
  );

  const add = () => {
    const title = draft.trim();
    if (title === "") return;
    applet.tables.todos.insert({
      id: newId(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    });
    setDraft("");
  };

  return (
    <Stack root gap="large">
      <Toolbar
        end={
          <Text size="small" tone="muted">
            {status}
          </Text>
        }
      >
        <Text size="title">__APPLET_NAME__</Text>
      </Toolbar>

      <Stack direction="row" gap="small" align="end">
        <Input
          label="New todo"
          value={draft}
          placeholder="Buy milk"
          onValueChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
        <Button variant="primary" onClick={add}>
          Add
        </Button>
      </Stack>

      {todos.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          description="Add your first todo above."
        />
      ) : (
        <List>
          {todos.map((todo) => (
            <ListItem
              key={todo.id}
              start={
                <Checkbox
                  checked={todo.done}
                  ariaLabel={`Mark "${todo.title}" done`}
                  onChange={(done) =>
                    applet.tables.todos.update(todo.id, (draftRow) => {
                      draftRow.done = done;
                    })
                  }
                />
              }
              end={
                <Button
                  variant="ghost"
                  onClick={() => applet.tables.todos.delete(todo.id)}
                >
                  Delete
                </Button>
              }
            >
              <Text tone={todo.done ? "muted" : "default"}>{todo.title}</Text>
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  );
}

mount(<App />);
