/**
 * The `applets` feed a bridge v2 page receives.
 *
 * This is a projection of what the shell has already read, never a second
 * source of truth: the backend is the authority for the list, the focus, and
 * the viewer credential, and a page that is handed a stale generation simply
 * reconnects when the next feed arrives.
 */
import {
  PACKAGE_IFRAME_FOCUS_TOOL_V2,
  type PackageIframeAppletsStateV2,
  type PackageIframeCatalogV1,
  type AppletSummaryV1,
} from "@frockbot/kernel-contracts";
import type { FrockBotWebData } from "../shared.js";

/**
 * Whether this Bot's Composition has Applets in it at all.
 *
 * Derived from manifest facts — a Package declaring the Applet focus tool —
 * never from a Package id. A deployment or a User without the Applets Package
 * has no Applet routes, and the shell must not ask for them: an absent
 * capability is silence, not a failed request.
 */
export function appletsAvailableV1(
  catalog: PackageIframeCatalogV1 | undefined,
): boolean {
  return (catalog?.contributions ?? []).some((contribution) =>
    contribution.declaredTools.includes(PACKAGE_IFRAME_FOCUS_TOOL_V2),
  );
}

export function focusedAppletSummaryV1(
  web: Pick<FrockBotWebData, "applets" | "focusedAppletId">,
): AppletSummaryV1 | null {
  const appletId = web.focusedAppletId;
  if (!appletId) return null;
  return web.applets.find((applet) => applet.appletId === appletId) ?? null;
}

export function appletsBridgeStateV2(
  web: Pick<
    FrockBotWebData,
    "applets" | "focusedAppletId" | "appletViewer" | "appletBuild"
  >,
): PackageIframeAppletsStateV2 {
  const viewer = web.appletViewer;
  return {
    focused: focusedAppletSummaryV1(web),
    list: web.applets,
    viewer:
      viewer && viewer.appletId === web.focusedAppletId
        ? {
            token: viewer.token,
            socketUrl: viewer.socketUrl,
            uiUrl: viewer.uiUrl,
            generationId: viewer.generationId,
          }
        : null,
    // The source stays out of the feed: the shell draws the code view itself,
    // and a source tree would overflow the bridge's 64 KB message bound.
    ...(web.appletBuild === undefined ? {} : { build: web.appletBuild }),
  };
}
