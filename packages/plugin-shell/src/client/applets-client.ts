/**
 * The client half of the Applet routes.
 *
 * The backend is the authority for every one of these reads; this module is
 * only the typed seam between the hosted transport and the shell's projection,
 * so a route that is absent from a deployment reads as "no Applets" rather
 * than as an error over the User's conversation. Every response crosses a
 * strict decoder before it reaches the shell.
 */
import {
  appletSourceArtefactPathV1,
  decodeAppletBuildViewV1,
  decodeAppletFocusViewV1,
  decodeAppletListViewV1,
  decodeAppletSourceViewV1,
  decodeAppletUiViewV1,
  decodeAppletViewerTokenV1,
  type AppletBuildViewV1,
  type AppletSourceViewV1,
  type AppletSummaryV1,
  type AppletUiViewV1,
  type AppletViewerTokenV1,
} from "@frockbot/kernel-contracts";

/** Exactly what the shell's hosted transport offers, and nothing more. */
export type AppletsHostedRequest = (
  path: string,
  method?: "GET" | "POST",
  body?: string,
) => Promise<unknown>;

const applet = (appletId: string) => encodeURIComponent(appletId);

export async function readAppletList(
  request: AppletsHostedRequest,
): Promise<AppletSummaryV1[]> {
  return decodeAppletListViewV1(await request("/api/applets")).applets;
}

export async function readAppletViewerToken(
  request: AppletsHostedRequest,
  appletId: string,
): Promise<AppletViewerTokenV1> {
  return decodeAppletViewerTokenV1(
    await request(`/api/applets/${applet(appletId)}/token`),
  );
}

export async function readAppletUi(
  request: AppletsHostedRequest,
  appletId: string,
): Promise<AppletUiViewV1> {
  return decodeAppletUiViewV1(
    await request(`/api/applets/${applet(appletId)}/ui`),
  );
}

/*
 * The canvas's two Workspace-backed reads are Bot-scoped in the URL and
 * User-scoped in what they answer: the Applets root belongs to the User, and
 * the Bot in the path only names the Durable Object that holds the Workspace
 * binding. Reading them wakes no Computer.
 */
export async function readAppletSource(
  request: AppletsHostedRequest,
  botId: string,
  appletId: string,
): Promise<AppletSourceViewV1> {
  return decodeAppletSourceViewV1(
    await request(
      `/api/bots/${encodeURIComponent(botId)}/applets/${applet(appletId)}/source`,
    ),
  );
}

export async function readAppletBuild(
  request: AppletsHostedRequest,
  botId: string,
  appletId: string,
): Promise<AppletBuildViewV1> {
  return decodeAppletBuildViewV1(
    await request(
      `/api/bots/${encodeURIComponent(botId)}/applets/${applet(appletId)}/build`,
    ),
  );
}

export async function readFocusedAppletId(
  request: AppletsHostedRequest,
  botId: string,
): Promise<string | null> {
  return decodeAppletFocusViewV1(
    await request(`/api/bots/${encodeURIComponent(botId)}/applets/focus`),
  ).appletId;
}

/**
 * Records the Session's focused Applet and returns what the backend recorded,
 * never what the click asked for: a focus the backend refused reads back as
 * the focus it kept.
 */
export async function writeFocusedAppletId(
  request: AppletsHostedRequest,
  botId: string,
  appletId: string | null,
): Promise<string | null> {
  return decodeAppletFocusViewV1(
    await request(
      `/api/bots/${encodeURIComponent(botId)}/applets/focus`,
      "POST",
      JSON.stringify({ schemaVersion: 1, appletId }),
    ),
  ).appletId;
}

/**
 * The Applet's own files, with machine output left out.
 *
 * A Workspace root that has been synced from a Computer carries whatever the
 * toolchain left behind — a wrangler cache, a dependency tree, a build. The
 * store stops carrying those from now on, but a root synced before that still
 * holds them, so the canvas filters what it draws rather than trusting the
 * listing to be clean.
 */
export function appletSourceFilesV1(
  source: AppletSourceViewV1 | undefined,
): AppletSourceViewV1["files"] {
  return (source?.files ?? []).filter(
    (file) => !appletSourceArtefactPathV1(file.path),
  );
}

/**
 * The file the canvas opens on while a Bot is writing an Applet: the one that
 * changed most recently, falling back to the first path in sorted order so a
 * store with no timestamps still opens on something.
 */
export function mostRecentlyChangedFileV1(
  source: AppletSourceViewV1 | undefined,
): string | undefined {
  const files = appletSourceFilesV1(source);
  if (files.length === 0) return undefined;
  // A tie on time — a fresh scaffold, one sync — opens on the file a Bot edits
  // first, not on the README the alphabet would pick. `applet.json` is the
  // Applet's own manifest and is what a person recognises when nothing else
  // has been written yet.
  const preferred = ["applet.json", "server.ts", "ui.tsx"];
  const ordered = files.toSorted((left, right) => {
    const leftAt = left.changedAt ?? "";
    const rightAt = right.changedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    const leftRank = preferred.indexOf(left.path);
    const rightRank = preferred.indexOf(right.path);
    const rank = (value: number) => (value < 0 ? preferred.length : value);
    return (
      rank(leftRank) - rank(rightRank) || left.path.localeCompare(right.path)
    );
  });
  return ordered[0]?.path;
}

/**
 * A stable identity for the source the canvas is showing.
 *
 * The canvas follows the Turn: a Turn that writes source lands the User on the
 * code. "Wrote source" has to be a fact about the files, though, not about the
 * store having been re-read — `refreshAppletCanvas` assigns a fresh view object
 * on every poll, so a watcher on the array itself fired on Turns that touched
 * no file at all and yanked the User off the live Applet.
 */
export function appletSourceFingerprintV1(
  source: AppletSourceViewV1 | undefined,
): string {
  if (!source) return "";
  return appletSourceFilesV1(source)
    .map((file) => `${file.path}@${file.generationId}@${file.changedAt ?? ""}`)
    .toSorted()
    .join("\n");
}

/** Re-mint the viewer credential once it is this close to expiring. */
export const APPLET_VIEWER_REFRESH_MS_V1 = 3 * 60_000;

/**
 * Whether a read of this Applet is the first one, and so may draw a skeleton.
 *
 * A skeleton is for an empty panel. The canvas re-reads the source on a
 * cadence while a Turn runs, and showing the loading state on each of those
 * replaced a live Applet — mid-use, mid-scroll — with four grey bars twice a
 * minute. Once anything for this Applet is on screen, a re-read happens
 * behind it.
 */
export function appletCanvasIsFirstReadV1(input: {
  appletId: string;
  viewerAppletId?: string;
  sourceAppletId?: string;
}): boolean {
  return (
    input.viewerAppletId !== input.appletId &&
    input.sourceAppletId !== input.appletId
  );
}

/**
 * Whether the viewer credential already in hand still opens this Applet.
 *
 * The published generation is what the open Applet *is*: while it is
 * unchanged and the credential has life left in it, nothing is re-fetched and
 * the frame keeps running. Re-minting a token on every Turn changed the props
 * the iframe host reads and reloaded a working Applet for no reason.
 */
export function appletViewerStillCurrentV1(input: {
  held?: { appletId: string; generationId: string; expiresAt: string };
  appletId: string;
  generationId: string;
  now?: number;
  refreshWithinMs?: number;
}): boolean {
  const held = input.held;
  if (!held) return false;
  if (held.appletId !== input.appletId) return false;
  if (held.generationId !== input.generationId) return false;
  const expiresAt = Date.parse(held.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  const now = input.now ?? Date.now();
  const within = input.refreshWithinMs ?? APPLET_VIEWER_REFRESH_MS_V1;
  return expiresAt - now >= within;
}
