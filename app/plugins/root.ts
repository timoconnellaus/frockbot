// Where a Bot-authored Plugin's source lives: one directory per Plugin under
// a Package-declared Workspace root of the User's (ADR 0026).
//
// The root is the User's, not a Bot's, for the same reason the Composition is:
// a Plugin the Bot publishes lands in every Bot of this User's generation, so
// its source is the User's to keep. Two Bots of one User editing one Plugin
// see one directory.
import type {
  WorkspacePathV1,
  WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { normalizeWorkspaceRelativePathV1 } from "@frockbot/core/contracts";

/** The Package the source root is declared under. */
export const PLUGINS_SOURCE_PACKAGE_ID_V1 = "plugins";
/** The declared root Plugin source is written under. */
export const PLUGINS_SOURCE_ROOT_ID_V1 = "source";

/** The two files a Plugin is: its module and its descriptor. */
export const PLUGIN_SOURCE_FILES_V1 = ["plugin.ts", "plugin.json"] as const;

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** The Plugin id in an id-shaped string, or a thrown error. */
export function assertPluginIdV1(pluginId: unknown): string {
  if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) {
    throw new Error("plugin id is invalid: expected ^[a-z][a-z0-9-]{0,63}$");
  }
  return pluginId;
}

/** The Package-declared Workspace root Plugin source lives in. */
export function pluginsSourceRootV1(userId: string): WorkspaceRootV1 {
  return {
    kind: "package-declared",
    userId,
    packageId: PLUGINS_SOURCE_PACKAGE_ID_V1,
    rootId: PLUGINS_SOURCE_ROOT_ID_V1,
  };
}

/**
 * One Plugin's source directory inside the root, as a relative prefix with a
 * trailing slash — `notes/` and `notes-2/` would otherwise share one.
 */
export function pluginSourcePathV1(pluginId: string): string {
  return `${assertPluginIdV1(pluginId)}/`;
}

/** One file inside a Plugin's source directory, as a Workspace path. */
export function pluginSourceFilePathV1(
  userId: string,
  pluginId: string,
  relativePath: string,
): WorkspacePathV1 {
  return {
    root: pluginsSourceRootV1(userId),
    path: normalizeWorkspaceRelativePathV1(
      `${pluginSourcePathV1(pluginId)}${relativePath}`,
      "plugin source path",
    ),
  };
}

/**
 * A Plugin id from what the User called it: lowercase, dashes, letters first.
 * `"Weather Alerts!"` is `weather-alerts`.
 */
export function pluginIdFromDisplayNameV1(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]*/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug.length === 0 ? "plugin" : slug;
}
