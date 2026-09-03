// Where an Applet's source lives, and why there.
//
// ADR 0022 decision 7: "Applet source lives under a `package-declared` durable
// root of the Applets Package, `applets/<appletId>/`, synchronized by the
// durable-root sync of ADR 0013." An Applet is *written* on the Computer and
// *run* in the loader, so its source has to be a real file a Bot can open with
// ordinary file tools, type-check, lint, and preview — and it has to survive
// hibernation, cold start, host migration, and an image rebuild. That is the
// definition of a durable root, and `package-declared` is the only kind a
// Package declares for itself (`kernel-contracts/src/workspace.ts`).
//
// The root is User-scoped, like every `package-declared` root: Applets are
// account-wide (ADR 0022 decision 3, plan D2), so one User's Bots share the
// root and an Applet a Bot wrote is an Applet every Bot of that User can edit.
// It is read-write on the Computer — unlike Memory and the User instruction
// root, whose single writer is a Package — because writing source with a shell
// is exactly what the Bot is meant to do here.
//
// The published artifact is *not* what runs. `applet build` writes
// `<appletId>/dist/` inside this root, the sync pushes it to object storage,
// and publish reads the built bytes back through the Workspace file surface
// (`syncWorkspaceRootNowV1` in `@frockbot/plugin-computer/agent` is the one
// sanctioned way to make that push happen outside the Turn's own policy). No
// credential ever reaches the Computer for the publish.
import {
  normalizeWorkspaceRelativePathV1,
  type WorkspacePathV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
// The Applet id shape is ADR 0015's share id, `<publicUserId>.<random>`, and
// this is its one validator. Reused rather than re-expressed: a second regex
// for the same shape is a second answer to "is this id well formed", and the
// difference between the two would be found by a path that accepted an id the
// share surface refuses. The name says `template` because that is where the
// shape was first needed, not because it is about templates.
import {
  parseTemplateShareIdV1,
  TemplateDecodeError,
} from "@frockbot/template-core";

/** The Package id the declared root belongs to. Matches `frockbot.json`. */
export const APPLETS_PACKAGE_ID_V1 = "applets";
/** The declared root Applet source is written under. */
export const APPLETS_SOURCE_ROOT_ID_V1 = "source";

/**
 * The Package-declared Workspace root Applet source lives in.
 *
 * On a Fly Sprite this resolves to
 * `/home/box/agent-data/user-packages/applets/source` — the layout's one
 * `package-declared` template with `{package}` and `{root}` substituted, so no
 * Computer Package learns that Applets exist.
 */
export function appletsSourceRootV1(userId: string): WorkspaceRootV1 {
  return {
    kind: "package-declared",
    userId,
    packageId: APPLETS_PACKAGE_ID_V1,
    rootId: APPLETS_SOURCE_ROOT_ID_V1,
  };
}

/**
 * The Applet id in an id-shaped string, or a thrown error.
 *
 * An Applet id is a path segment on a real filesystem and a directory the sync
 * reconciles, so it is validated rather than folded: an id that is not the
 * shape the kernel mints is a caller's bug, and quietly rewriting it into a
 * different directory would make two Applets share one source tree.
 */
export function assertAppletIdV1(appletId: unknown): string {
  try {
    parseTemplateShareIdV1(appletId);
  } catch (error) {
    throw new Error(
      error instanceof TemplateDecodeError
        ? "applet id is invalid"
        : String(error),
    );
  }
  return appletId as string;
}

/**
 * One Applet's source directory inside the root, as a relative prefix.
 *
 * Trailing slash, because it is a directory prefix and every caller either
 * lists under it or joins a file onto it — `applets/<id>` and `applets/<id>2`
 * would otherwise share a prefix.
 */
export function appletSourcePathV1(appletId: string): string {
  return `${assertAppletIdV1(appletId)}/`;
}

/** One file inside an Applet's source directory, as a Workspace path. */
export function appletSourceFilePathV1(
  userId: string,
  appletId: string,
  relativePath: string,
): WorkspacePathV1 {
  return {
    root: appletsSourceRootV1(userId),
    path: normalizeWorkspaceRelativePathV1(
      `${appletSourcePathV1(appletId)}${relativePath}`,
      "applet source path",
    ),
  };
}

/** Where `applet build` leaves the artifacts publish reads. */
export const APPLET_DIST_DIRECTORY_V1 = "dist";
