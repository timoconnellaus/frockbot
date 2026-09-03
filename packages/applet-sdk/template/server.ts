import { Applet, t, table } from "@frockbot/applet-sdk/server";

/**
 * The schema. It becomes the SQLite tables, the wire format, and the client's
 * collections, and it survives every publish: changing this file's code never
 * clears the rows.
 */
const tables = {
  todos: table({
    id: t.id(),
    title: t.text(),
    done: t.boolean().default(false),
    createdAt: t.timestamp(),
  }),
};

/**
 * The server half of __APPLET_NAME__.
 *
 * `tools` is what every Bot of this User can call. `this.db` is the only way
 * to read or write, and each call is atomic.
 */
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
    list_todos: this.tool(
      { description: "List the todos, open ones first", input: {} },
      () => {
        const todos = this.db.todos.select();
        if (todos.length === 0) return "The list is empty.";
        return todos
          .sort((left, right) => Number(left.done) - Number(right.done))
          .map((todo) => `${todo.done ? "[x]" : "[ ]"} ${todo.title}`)
          .join("\n");
      },
    ),
  };
}
