/**
 * `@frockbot/compose-typescript` — the **source checker** for written plugins.
 * It type-checks **plugin source** against the **plugin declarations** derived
 * from the **stubs** the entry was granted, and returns the plain ES module the
 * **host** starts. What type-checks against the declarations is what runs.
 *
 * Terms are the ones in `CONTEXT.md`; the criteria it meets are D7, D8 and D9
 * of `docs/acceptance/self-modification.md`.
 */

export { createTypeScriptChecker } from "./checker";
export { baseDeclarations, pluginDeclarations } from "./declarations";
export type { GrantDeclarations } from "./declarations";
