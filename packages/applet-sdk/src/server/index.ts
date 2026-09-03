/**
 * `@frockbot/applet-sdk/server` — everything an Applet's `server.ts` imports.
 *
 * ```ts
 * import { Applet, table, t } from "@frockbot/applet-sdk/server";
 *
 * export default class TodoApplet extends Applet {
 *   tables = { todos: table({ id: t.id(), title: t.text() }) };
 *   tools = {
 *     add_todo: this.tool(
 *       { description: "Add a todo", input: { title: t.text() } },
 *       ({ title }) => { this.db.todos.insert({ title }); return `Added ${title}`; },
 *     ),
 *   };
 * }
 * ```
 */

export {
  Applet,
  type AppletDb,
  type AppletDescriptionV1,
  type AppletHealthV1,
  type AppletTableApi,
  type AppletTool,
  type AppletToolDeclarationV1,
  type AppletToolSpec,
  type ToolInputOf,
} from "./applet.js";
export {
  AppletValidationError,
  Column,
  table,
  t,
  TableDefinition,
  type ColumnKind,
  type ColumnsShape,
  type InsertOf,
  type JsonSchemaObject,
  type PatchOf,
  type RowOf,
  type TablesShape,
} from "../schema/index.js";
export {
  APPLET_CONTRACT_VERSION,
  APPLET_FRAME_BYTE_LIMIT,
  type AppletChangeV1,
  type AppletClientFrameV1,
  type AppletMutationV1,
  type AppletServerFrameV1,
  type AppletViewerV1,
} from "../protocol/index.js";
export { AppletStore, type AppletSqlStorage } from "./store.js";
