import { sourceErrorOf, stubDeclarations } from "@frockbot/compose-core";
import { jsonSchemaValidator, schemaOf } from "./json-schema";
import type {
  AnyPlugin,
  AnyStubGrant,
  Client,
  PluginEntry,
  SourceDiagnostic,
  SourceError,
  StandardSchemaIssue,
  Status,
} from "@frockbot/compose-core";
import type { DescribedValidator, JsonSchema } from "./json-schema";

/** One plugin-list row as reported to an agent runtime. */
export interface ComposerEntry {
  id: string;
  plugin: string;
  kind: "plugin" | "source";
  enabled: boolean;
  protected: boolean;
  status: Status | "disabled";
  missing?: Array<string>;
  error?: string;
  sourceError?: SourceError;
  options?: unknown;
  optionsSchema?: JsonSchema;
  readable?: boolean;
}

/** The common result shape returned by every composer tool. */
export interface ComposerResult {
  ok: boolean;
  message: string;
  error?: string;
  entries: Array<ComposerEntry>;
  effect?: string;
  catalog?: Array<string>;
  catalogOptions?: Record<string, JsonSchema>;
  source?: string;
  declarations?: string;
  diagnostics?: Array<SourceDiagnostic>;
}

/** A runtime-neutral tool definition that any agent implementation can mount. */
export interface ComposerToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  validator: DescribedValidator<unknown, TArgs>;
  concurrency: "exclusive";
  execute: (args: TArgs) => ComposerResult | Promise<ComposerResult>;
}

/** Any composer definition, regardless of its argument type. */
export type AnyComposerTool = ComposerToolDefinition<any>;

/** Operator-owned limits applied to the composer definitions. */
export interface ComposerOptions {
  client: Client;
  catalog?: Readonly<Record<string, AnyPlugin>>;
  protected?: ReadonlyArray<string>;
  stubs?: ReadonlyArray<AnyStubGrant>;
  host?: string;
}

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const issuesOf = (issues: ReadonlyArray<StandardSchemaIssue>): string =>
  issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          typeof segment === "object" ? String(segment.key) : String(segment),
        )
        .join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");

const nextTurn =
  "Takes effect from the next turn: a turn keeps the tools and prompt it opened with.";

const idSchema: JsonSchema = {
  type: "string",
  description: "The plugin entry id.",
};

const definition = <TArgs>(input: {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: ComposerToolDefinition<TArgs>["execute"];
}): ComposerToolDefinition<TArgs> => ({
  ...input,
  validator: jsonSchemaValidator<TArgs>(input.parameters),
  concurrency: "exclusive",
});

/** The stable names returned by {@link createComposerTools}. */
export const composerToolNames = [
  "list_plugins",
  "enable_plugin",
  "disable_plugin",
  "configure_plugin",
  "add_from_catalog",
  "read_plugin",
  "write_plugin",
  "rewrite_plugin",
  "remove_plugin",
] as const;

/**
 * Create the framework-neutral composer tool definitions for one client.
 * Policy is captured by this call and cannot be changed by a tool invocation.
 */
export function createComposerTools(
  given: ComposerOptions,
): Array<AnyComposerTool> {
  const client = given.client;
  const catalog = { ...given.catalog };
  const protectedIds = [...(given.protected ?? [])];
  const stubs = [...(given.stubs ?? [])];
  const observed = new Map<string, string>();
  const written = new Set<string>();

  const list = (): Array<PluginEntry> => client.pluginList.state;
  const entryOf = (id: string): PluginEntry | undefined =>
    list().find((entry) => entry.id === id);
  const isProtected = (id: string): boolean => protectedIds.includes(id);
  const declarations = (): string =>
    client.checker?.declarations?.(
      stubs.map((stub) => ({
        name: stub.name,
        declarations: stub.declarations,
      })),
    ) ?? stubDeclarations(stubs);

  const statusOf = (id: string): Status | "disabled" => {
    const entry = entryOf(id);
    if (!entry) return "removed";
    if (entry.enabled === false) return "disabled";
    return client.inspect().find((row) => row.id === id)?.status ?? "removed";
  };

  const report = (id: string): ComposerEntry => {
    const entry = entryOf(id);
    const snapshot = client.inspect().find((row) => row.id === id);
    const source = entry?.source !== undefined;
    const status = statusOf(id);
    const row: ComposerEntry = {
      id,
      plugin:
        entry === undefined ? "removed" : source ? "source" : entry.plugin.name,
      kind: source ? "source" : "plugin",
      enabled: entry !== undefined && entry.enabled !== false,
      protected: isProtected(id),
      status,
    };
    if (status === "pending") row.missing = snapshot?.missing ?? [];
    if (status === "error") {
      row.error = messageOf(snapshot?.error);
      const detail = sourceErrorOf(snapshot?.error);
      if (detail) row.sourceError = detail;
    }
    if (source) row.readable = true;
    if (entry?.options !== undefined) row.options = entry.options;
    const schema = schemaOf(entry?.plugin?.validator);
    if (schema) row.optionsSchema = schema;
    return row;
  };

  const rowsFor = (targets: ReadonlyArray<string>): Array<ComposerEntry> =>
    list()
      .filter((entry) => {
        const status = statusOf(entry.id);
        return (
          targets.includes(entry.id) ||
          status === "pending" ||
          status === "error"
        );
      })
      .map((entry) => report(entry.id));

  const failure = (
    message: string,
    targets: ReadonlyArray<string> = [],
    extra: Partial<ComposerResult> = {},
  ): ComposerResult => ({
    ok: false,
    message,
    error: message,
    entries: rowsFor(targets),
    ...extra,
  });

  const apply = async (
    next: Array<PluginEntry>,
  ): Promise<string | undefined> => {
    try {
      await client.setPluginList(next);
      await client.settled();
      return undefined;
    } catch (error) {
      await client.settled();
      return messageOf(error);
    }
  };

  const optionsProblem = async (
    plugin: AnyPlugin,
    value: unknown,
    supplied: boolean,
  ): Promise<string | undefined> => {
    if (!plugin.validator) {
      return supplied ? "this plugin declares no options" : undefined;
    }
    const result = await plugin.validator["~standard"].validate(value);
    return result.issues ? issuesOf(result.issues) : undefined;
  };

  const check = async (
    id: string,
    source: string,
  ): Promise<Array<SourceDiagnostic> | undefined> => {
    if (!client.checker) return undefined;
    const grants = stubs.map((stub) => ({
      name: stub.name,
      declarations: stub.declarations,
    }));
    const checked = await client.checker.check({
      baseVersion: client.baseVersion,
      instanceId: id,
      source,
      declarations: stubDeclarations(stubs),
      grants,
    });
    return typeof checked.code === "string"
      ? undefined
      : (checked.diagnostics ?? []);
  };

  const said = (diagnostics: ReadonlyArray<SourceDiagnostic>): string =>
    diagnostics
      .map((item) =>
        item.line === undefined
          ? item.message
          : `${item.line}:${item.column ?? 0} ${item.message}`,
      )
      .join("; ") || "the source checker rejected this source";

  const setEnabled = async (
    id: string,
    enabled: boolean,
  ): Promise<ComposerResult> => {
    const entry = entryOf(id);
    if (!entry) return failure(`there is no plugin entry "${id}"`, [id]);
    if (isProtected(id)) {
      return failure(`the entry "${id}" is protected and cannot be changed`, [
        id,
      ]);
    }
    if ((entry.enabled !== false) === enabled) {
      return {
        ok: true,
        message: `the entry "${id}" is already ${enabled ? "enabled" : "disabled"}`,
        entries: rowsFor([id]),
      };
    }
    const failed = await apply(
      list().map((item) => (item.id === id ? { ...item, enabled } : item)),
    );
    if (failed) return failure(failed, [id]);
    return {
      ok: true,
      message: `the entry "${id}" is now ${enabled ? "enabled" : "disabled"}`,
      entries: rowsFor([id]),
      effect: nextTurn,
    };
  };

  const listTool = definition<Record<string, never>>({
    name: "list_plugins",
    description:
      "List every plugin entry with status, protection, options and options schema; list the closed catalog and the declarations used for written source.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => ({
      ok: true,
      message: "The plugin list, as it runs now.",
      entries: list().map((entry) => report(entry.id)),
      catalog: Object.keys(catalog),
      catalogOptions: Object.fromEntries(
        Object.entries(catalog).flatMap(([name, plugin]) => {
          const schema = schemaOf(plugin.validator);
          return schema ? [[name, schema]] : [];
        }),
      ),
      declarations: declarations(),
    }),
  });

  const enableTool = definition<{ id: string }>({
    name: "enable_plugin",
    description: "Enable an unprotected plugin entry.",
    parameters: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
      additionalProperties: false,
    },
    execute: ({ id }) => setEnabled(id, true),
  });

  const disableTool = definition<{ id: string }>({
    name: "disable_plugin",
    description: "Disable an unprotected plugin entry.",
    parameters: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
      additionalProperties: false,
    },
    execute: ({ id }) => setEnabled(id, false),
  });

  const configureTool = definition<{ id: string; options: unknown }>({
    name: "configure_plugin",
    description:
      "Replace an entry's whole options object after validating it with the plugin's validator.",
    parameters: {
      type: "object",
      properties: { id: idSchema, options: {} },
      required: ["id", "options"],
      additionalProperties: false,
    },
    execute: async ({ id, options }): Promise<ComposerResult> => {
      const entry = entryOf(id);
      if (!entry) return failure(`there is no plugin entry "${id}"`, [id]);
      if (isProtected(id)) {
        return failure(`the entry "${id}" is protected and cannot be changed`, [
          id,
        ]);
      }
      if (!entry.plugin) {
        return failure(
          `the source entry "${id}" declares no options validator`,
          [id],
        );
      }
      const problem = await optionsProblem(entry.plugin, options, true);
      if (problem)
        return failure(`invalid options for "${id}" — ${problem}`, [id]);
      const failed = await apply(
        list().map((item) => (item.id === id ? { ...item, options } : item)),
      );
      if (failed) return failure(failed, [id]);
      return {
        ok: true,
        message: `the entry "${id}" restarted with its new options`,
        entries: rowsFor([id]),
        effect: nextTurn,
      };
    },
  });

  const addTool = definition<{
    id?: string;
    name: string;
    options?: unknown;
  }>({
    name: "add_from_catalog",
    description:
      "Add a plugin from the closed catalog under an unused id. The id defaults to the catalog name.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Defaults to the catalog name." },
        name: { type: "string", description: "A name from the catalog." },
        options: {},
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({
      id: wanted,
      name,
      ...input
    }): Promise<ComposerResult> => {
      const id = wanted ?? name;
      const plugin = Object.prototype.hasOwnProperty.call(catalog, name)
        ? catalog[name]
        : undefined;
      if (!plugin) {
        return failure(
          `there is no plugin named "${name}" in the catalog; it offers ${
            Object.keys(catalog).join(", ") || "nothing"
          }`,
          [],
          { catalog: Object.keys(catalog) },
        );
      }
      if (entryOf(id)) {
        return failure(`the entry id "${id}" is already in the plugin list`, [
          id,
        ]);
      }
      if (isProtected(id)) {
        return failure(`the entry id "${id}" is protected and cannot be used`, [
          id,
        ]);
      }
      const supplied = Object.prototype.hasOwnProperty.call(input, "options");
      const problem = await optionsProblem(plugin, input.options, supplied);
      if (problem) return failure(`invalid options for "${name}" — ${problem}`);
      const failed = await apply([
        ...list(),
        {
          id,
          plugin,
          ...(supplied ? { options: input.options } : {}),
        },
      ]);
      if (failed) return failure(failed, [id]);
      return {
        ok: true,
        message: `added "${name}" from the catalog as the entry "${id}"`,
        entries: rowsFor([id]),
        effect: nextTurn,
      };
    },
  });

  const readTool = definition<{ id: string }>({
    name: "read_plugin",
    description:
      "Read a source entry and the declarations it is checked against. Reading establishes the rewrite gate.",
    parameters: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
      additionalProperties: false,
    },
    execute: ({ id }): ComposerResult => {
      const entry = entryOf(id);
      if (!entry) return failure(`there is no plugin entry "${id}"`, [id]);
      if (entry.source === undefined) {
        return failure(
          `the entry "${id}" is a plugin from the assembly or the catalog and has no source to read`,
          [id],
        );
      }
      if (!written.has(id)) {
        return failure(
          `the entry "${id}" was not written by this agent, so its source cannot be read`,
          [id],
        );
      }
      observed.set(id, entry.source);
      return {
        ok: true,
        message: `the source of "${id}", as it runs now`,
        entries: rowsFor([id]),
        source: entry.source,
        declarations: declarations(),
      };
    },
  });

  const writeTool = definition<{ id: string; source: string }>({
    name: "write_plugin",
    description:
      "Check and add a new TypeScript source entry. It receives only the operator-selected grants.",
    parameters: {
      type: "object",
      properties: {
        id: idSchema,
        source: { type: "string", description: "The complete module source." },
      },
      required: ["id", "source"],
      additionalProperties: false,
    },
    execute: async ({ id, source }): Promise<ComposerResult> => {
      if (entryOf(id)) {
        return failure(`the entry id "${id}" is already in the plugin list`, [
          id,
        ]);
      }
      if (isProtected(id)) {
        return failure(`the entry id "${id}" is protected and cannot be used`, [
          id,
        ]);
      }
      const wrong = await check(id, source);
      if (wrong) {
        return failure(said(wrong), [id], {
          diagnostics: wrong,
          declarations: declarations(),
        });
      }
      const failed = await apply([
        ...list(),
        {
          id,
          source,
          stubs,
          ...(given.host === undefined ? {} : { host: given.host }),
        },
      ]);
      if (failed) return failure(failed, [id]);
      written.add(id);
      const row = report(id);
      if (row.status === "error") {
        return failure(`the source of "${id}" did not start`, [id], {
          error: row.error ?? `the source of "${id}" did not start`,
          ...(row.sourceError?.diagnostics
            ? { diagnostics: row.sourceError.diagnostics }
            : {}),
        });
      }
      return {
        ok: true,
        message: `wrote the entry "${id}"`,
        entries: rowsFor([id]),
        effect: nextTurn,
      };
    },
  });

  const rewriteTool = definition<{ id: string; source: string }>({
    name: "rewrite_plugin",
    description:
      "Replace source after read_plugin, only if the source is unchanged since it was read.",
    parameters: {
      type: "object",
      properties: {
        id: idSchema,
        source: {
          type: "string",
          description: "The complete replacement module.",
        },
      },
      required: ["id", "source"],
      additionalProperties: false,
    },
    execute: async ({ id, source }): Promise<ComposerResult> => {
      const entry = entryOf(id);
      if (!entry) return failure(`there is no plugin entry "${id}"`, [id]);
      if (isProtected(id)) {
        return failure(`the entry "${id}" is protected and cannot be changed`, [
          id,
        ]);
      }
      if (entry.source === undefined) {
        return failure(`the entry "${id}" is not a source entry`, [id]);
      }
      if (!written.has(id)) {
        return failure(
          `the entry "${id}" was not written by this agent, so it cannot be rewritten`,
          [id],
        );
      }
      const seen = observed.get(id);
      if (seen === undefined) {
        return failure(
          `read the source of "${id}" with read_plugin before rewriting it`,
          [id],
        );
      }
      if (seen !== entry.source) {
        observed.delete(id);
        return failure(
          `the source of "${id}" has changed since you read it; read it again and try again`,
          [id],
        );
      }
      const wrong = await check(id, source);
      if (wrong) {
        return failure(said(wrong), [id], {
          diagnostics: wrong,
          declarations: declarations(),
        });
      }
      observed.delete(id);
      const failed = await apply(
        list().map((item) =>
          item.id === id
            ? {
                id,
                source,
                options: item.options,
                enabled: item.enabled,
                stubs,
                ...(given.host === undefined ? {} : { host: given.host }),
              }
            : item,
        ),
      );
      if (failed) return failure(failed, [id]);
      const row = report(id);
      if (row.status === "error") {
        return failure(`the source of "${id}" did not start`, [id], {
          error: row.error ?? `the source of "${id}" did not start`,
          ...(row.sourceError?.diagnostics
            ? { diagnostics: row.sourceError.diagnostics }
            : {}),
        });
      }
      return {
        ok: true,
        message: `rewrote the entry "${id}"`,
        entries: rowsFor([id]),
        effect: nextTurn,
      };
    },
  });

  const removeTool = definition<{ id: string }>({
    name: "remove_plugin",
    description:
      "Remove one unprotected plugin entry and release its resources.",
    parameters: {
      type: "object",
      properties: { id: idSchema },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async ({ id }): Promise<ComposerResult> => {
      const entry = entryOf(id);
      if (!entry) return failure(`there is no plugin entry "${id}"`, [id]);
      if (isProtected(id)) {
        return failure(`the entry "${id}" is protected and cannot be removed`, [
          id,
        ]);
      }
      const failed = await apply(list().filter((item) => item.id !== id));
      if (failed) return failure(failed, [id]);
      observed.delete(id);
      written.delete(id);
      return {
        ok: true,
        message: `removed the entry "${id}"`,
        entries: [
          {
            id,
            plugin: entry.source === undefined ? "removed" : "source",
            kind: entry.source === undefined ? "plugin" : "source",
            enabled: false,
            protected: false,
            status: "removed",
          },
          ...rowsFor([]),
        ],
        effect: nextTurn,
      };
    },
  });

  return [
    listTool,
    enableTool,
    disableTool,
    configureTool,
    addTool,
    readTool,
    writeTool,
    rewriteTool,
    removeTool,
  ];
}

/** Build the live prompt section an agent runtime may mount beside the tools. */
export function composerPrompt(
  options: Omit<ComposerOptions, "client">,
): string {
  const protectedIds = [...(options.protected ?? [])];
  const catalog = Object.keys(options.catalog ?? {});
  return [
    "You can inspect and edit the application plugin list with the plugin tools.",
    "An entry can be active, pending, error, disabled, or removed. Every edit reports its direct and dependency consequences.",
    "Use list_plugins to inspect current options, option schemas, catalog names, and the declarations for source.",
    "Use write_plugin only for a new id. Before changing source, use read_plugin and then rewrite_plugin. Source receives only the grants shown in its declarations.",
    protectedIds.length === 0
      ? "No entry is protected."
      : `Protected entries: ${protectedIds.join(", ")}. They cannot be changed.`,
    catalog.length === 0
      ? "The catalog is empty."
      : `The catalog offers: ${catalog.join(", ")}.`,
    "Plugin-list changes are immediate; their tool and prompt effects begin from the next turn because this turn keeps the world it opened with.",
  ].join(" ");
}
