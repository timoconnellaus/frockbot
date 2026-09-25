// A Plugin's device module: code the desktop runs for it (ADR 0037).
//
// The module is built from `modules/<id>.ts` in the Plugin's source into one
// ES module and stored content-addressed beside the Plugin's worker. A
// Composition member names each stored module by the id its descriptor
// declares, so the generation's hash covers what the desktop will run and a
// revert restores it with everything else.

/** Where a stored module lives in the artifact bucket. */
export function pluginModuleKeyV1(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("plugin module contentHash is invalid");
  }
  return `plugin-modules/${contentHash}.js`;
}

/** The source file a module id is built from. */
export function pluginModuleSourcePathV1(moduleId: string): string {
  return `modules/${moduleId}.ts`;
}

/** One module a Composition member carries, by the id its descriptor names. */
export interface PluginModuleArtifactV1 {
  id: string;
  /** sha-256 hex of the stored module. */
  contentHash: string;
  size: number;
}
