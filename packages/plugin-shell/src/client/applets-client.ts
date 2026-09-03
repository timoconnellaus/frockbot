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
 * The file the canvas shows while a Bot is writing an Applet: the one that
 * changed most recently, falling back to the first path in sorted order so a
 * store with no timestamps still opens on something.
 */
export function mostRecentlyChangedFileV1(
  source: AppletSourceViewV1 | undefined,
): string | undefined {
  if (!source || source.files.length === 0) return undefined;
  // A tie on time — a fresh scaffold, one sync — opens on the file a Bot edits
  // first, not on the README the alphabet would pick.
  const preferred = ["server.ts", "ui.tsx"];
  const ordered = source.files.toSorted((left, right) => {
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
