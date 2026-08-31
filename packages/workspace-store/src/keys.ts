// Where a durable-root file lives in object storage, and where its losing
// writes are preserved.
//
// One scheme, in one place, because three things must agree on it: this
// package, the Computer-side sync agent of ADR 0013, and anything that reads
// the bucket to rebuild an index.
//
//   file      workspace/<workspaceRootKeyV1(root)>/<relative>
//   conflict  workspace/<workspaceRootKeyV1(root)>/<relative>.conflict/<generationId>
//
// The conflict key is a *prefix* of nothing a file can occupy, and that is
// enforced rather than assumed: `normalizeWorkspaceRelativePathV1` refuses any
// segment ending in `.conflict`, so `notes.conflict/a.md` is not a path a
// caller can present. Listing a root therefore skips any key containing
// `/<name>.conflict/`, and a preserved losing write is durable, addressable,
// and never mistaken for the file it lost to.
import {
  WORKSPACE_CONFLICT_SEGMENT_SUFFIX,
  workspaceRootKeyV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";

/** Every durable-root object lives under this prefix. */
export const WORKSPACE_OBJECT_PREFIX = "workspace";
/** The segment marking a preserved losing write; a path may not end in it. */
export const WORKSPACE_CONFLICT_SUFFIX = WORKSPACE_CONFLICT_SEGMENT_SUFFIX;

/** The prefix every object of one durable root shares. */
export function workspaceObjectPrefixV1(root: WorkspaceRootV1): string {
  return `${WORKSPACE_OBJECT_PREFIX}/${workspaceRootKeyV1(root)}/`;
}

/** The object key holding one file's current bytes. */
export function workspaceObjectKeyV1(
  root: WorkspaceRootV1,
  path: string,
): string {
  return `${workspaceObjectPrefixV1(root)}${path}`;
}

/** The object key preserving one losing write. */
export function workspaceConflictKeyV1(
  root: WorkspaceRootV1,
  path: string,
  generationId: string,
): string {
  return `${workspaceObjectKeyV1(root, path)}${WORKSPACE_CONFLICT_SUFFIX}/${generationId}`;
}

/** True for a key that preserves a losing write rather than holding a file. */
export function isWorkspaceConflictKeyV1(key: string): boolean {
  return key.includes(`${WORKSPACE_CONFLICT_SUFFIX}/`);
}

/** The relative path a file key names inside its root, if it names one. */
export function workspaceRelativeFromKeyV1(
  root: WorkspaceRootV1,
  key: string,
): string | undefined {
  const prefix = workspaceObjectPrefixV1(root);
  if (!key.startsWith(prefix)) return undefined;
  const relative = key.slice(prefix.length);
  return relative.length > 0 ? relative : undefined;
}
