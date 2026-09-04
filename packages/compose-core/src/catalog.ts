import { createPlugin } from "./definitions";
import type { AnyPlugin, PluginEntry } from "./definitions";
import type { AnyStubGrant } from "./host";

/** A plugin reference that can be persisted outside a client. */
export type SerializedPlugin = { catalog: string } | { source: string };

/** Plain data accepted by the plugin-list serializer and host boundaries. */
export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | Array<SerializedValue>
  | { [key: string]: SerializedValue | undefined };

/** The serializable form of one plugin-list entry. */
export interface SerializedPluginEntry {
  id: string;
  plugin: SerializedPlugin;
  options?: SerializedValue;
  enabled?: boolean;
  stubs: Array<string>;
  host?: string;
}

/** Named values used to serialize and resolve a plugin list. */
export interface PluginCatalog {
  plugins: Readonly<Record<string, AnyPlugin>>;
  stubs: Readonly<Record<string, AnyStubGrant>>;
}

const nameOf = <T>(values: Readonly<Record<string, T>>, value: T): string => {
  const found = Object.entries(values).find(
    ([, candidate]) => candidate === value,
  );
  if (!found) throw new Error("value is not named in the catalog");
  return found[0];
};

/** Serialize runtime plugin entries by their catalog identities. */
export function serializePluginList(
  entries: ReadonlyArray<PluginEntry>,
  catalog: PluginCatalog,
): Array<SerializedPluginEntry> {
  return entries.map((entry) => ({
    id: entry.id,
    plugin:
      entry.plugin === undefined
        ? { source: entry.source }
        : { catalog: nameOf(catalog.plugins, entry.plugin) },
    options: entry.options as SerializedValue | undefined,
    enabled: entry.enabled,
    stubs: (entry.stubs ?? []).map((stub) => nameOf(catalog.stubs, stub)),
    ...(entry.host === undefined ? {} : { host: entry.host }),
  }));
}

const missingPlugin = (name: string): AnyPlugin =>
  createPlugin({
    name,
    setup() {
      throw new Error(`no plugin named "${name}" in the catalog`);
    },
  });

/** Resolve a serializable list, containing unknown catalog plugins as errors. */
export function resolvePluginList(
  entries: ReadonlyArray<SerializedPluginEntry>,
  catalog: PluginCatalog,
): Array<PluginEntry> {
  return entries.map((entry): PluginEntry => {
    const common = {
      id: entry.id,
      options: entry.options,
      enabled: entry.enabled,
    };
    if ("catalog" in entry.plugin) {
      return {
        ...common,
        plugin:
          catalog.plugins[entry.plugin.catalog] ??
          missingPlugin(entry.plugin.catalog),
      };
    }
    return {
      ...common,
      source: entry.plugin.source,
      stubs: entry.stubs.map((name) => {
        const stub = catalog.stubs[name];
        if (!stub) throw new Error(`no stub named "${name}" in the catalog`);
        return stub;
      }),
      // Older serialized rows may omit this field; resolve them to an empty
      // host so the runtime records a visible fail-closed activation error.
      host: entry.host ?? "",
    };
  });
}
