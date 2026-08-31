// Where a generated image lives, and why there.
//
// The durable Workspace, under a root this Package's manifest declares:
// `{kind: "package-declared", userId, packageId: "image", rootId: "generated"}`
// (`kernel-contracts/src/workspace.ts`). Object storage backs it, every write
// records its writer and produces a generation, and the durable-root sync
// (ADR 0013) presents it on the Computer as a real file the Bot can open with
// ordinary file tools — none of which is true of a data URL in the event log,
// the Durable Object's own storage, or a Memory root (single-writer,
// Markdown-only, and never written through the kernel file surface).
//
// `package-declared` roots are User-scoped, so one User's Bots share the root
// and each Bot's images sit under its own directory. That is the constitution's
// own rule for a Computer: "Bots of one User may read each other's Workspace
// files"; separation between them is organizational.
//
// The object is named by the *effect*, not by the prompt or a random id. That
// is the reconciliation fence: an interrupted Turn asks the Workspace whether
// the object for its effect exists, and the answer settles the effect without
// running — and therefore without billing — the model a second time.
import {
  normalizeWorkspaceRelativePathV1,
  type WorkspacePathV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";

/** The Package id the declared root belongs to. Matches `frockbot.json`. */
export const IMAGE_PACKAGE_ID_V1 = "image";
/** The declared root generated images are written under. */
export const IMAGE_GENERATED_ROOT_ID_V1 = "generated";

/** The Bot and User a generated image is attributed to. */
export interface ImageOwnerV1 {
  userId: string;
  botId: string;
}

/** The Package-declared Workspace root this Package writes. */
export function generatedImageRootV1(userId: string): WorkspaceRootV1 {
  return {
    kind: "package-declared",
    userId,
    packageId: IMAGE_PACKAGE_ID_V1,
    rootId: IMAGE_GENERATED_ROOT_ID_V1,
  };
}

/**
 * One path segment made safe. An `effectId` is minted by the Agent loop as
 * `tool:<turn>:<step>:<index>`; a Bot id is arbitrary durable text. Neither is
 * a filename, so both are folded to a conservative alphabet rather than
 * trusted — the Workspace would accept a colon, but a Computer's filesystem is
 * where these land and there is no reason to find out which ones it dislikes.
 */
export function imagePathSegmentV1(value: string): string {
  const folded = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!folded) throw new Error("image path segment is empty");
  return folded.slice(0, 128);
}

/**
 * The object one effect writes. Effect-keyed, so reconciliation reads exactly
 * the object the interrupted attempt would have written.
 */
export function generatedImagePathV1(
  owner: ImageOwnerV1,
  effectId: string,
  extension: string,
): WorkspacePathV1 {
  return {
    root: generatedImageRootV1(owner.userId),
    path: normalizeWorkspaceRelativePathV1(
      `${imagePathSegmentV1(owner.botId)}/${imagePathSegmentV1(effectId)}.${imagePathSegmentV1(extension)}`,
      "generated image path",
    ),
  };
}

/** The file extension for a container this Package writes. */
export function imageExtensionV1(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : "png";
}
