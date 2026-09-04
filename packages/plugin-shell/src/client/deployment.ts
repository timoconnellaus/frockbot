/**
 * Following a release in a page that is already open.
 *
 * FrockBot ships several times a day and a tab stays open for days, so the
 * ordinary case is old client code talking to a new backend. Every answer
 * names the application it came from; when that stops matching the one this
 * page was served, the page is behind and has to be replaced.
 *
 * Replacing it is destructive — a reload throws away the composer draft, the
 * open overlay, and any live capture — so the shell only does it on its own
 * when there is nothing to lose, and otherwise offers it and waits.
 */

/** What the shell should do about a page that is behind. */
export type DeploymentFollowV1 = "reload" | "offer" | "none";

/** The bar's whole text. Plain words: nobody needs to hear about a hash. */
export const DEPLOYMENT_UPDATED_MESSAGE_V1 =
  "FrockBot has updated. Reload when you're ready.";

/** The bar's button. */
export const DEPLOYMENT_RELOAD_LABEL_V1 = "Reload";

/**
 * Where the last automatic reload is remembered. Session storage, so it is
 * per-tab and goes away with the tab, which is the same lifetime as the
 * problem it guards.
 */
export const DEPLOYMENT_RELOAD_MARKER_V1 = "frockbot.deployment-reloaded-v1";

/**
 * The shortest gap between two automatic reloads of one tab.
 *
 * The guard matters because a reload is not guaranteed to fix the mismatch: a
 * cached bundle, or a deploy still rolling out, can serve the old client
 * again. Without this the page would reload forever. One a minute at worst
 * leaves the bar to say the rest.
 */
export const DEPLOYMENT_RELOAD_INTERVAL_MS_V1 = 60_000;

/** Whether the answering application is a different one from the served one. */
export function deploymentStaleV1(
  served: string | undefined,
  answered: string | undefined,
): boolean {
  if (!served || !answered) return false;
  return served !== answered;
}

export interface DeploymentFollowInputV1 {
  /** The answering application differs from the served one. */
  stale: boolean;
  /** A Turn is executing for the open Bot. */
  turnRunning: boolean;
  /** What is typed in the composer and not yet sent. */
  draft: string;
  /** A surface is floating over the workspace. */
  overlayOpen: boolean;
  /** A microphone is open, dictating or in a Voice session. */
  listening: boolean;
  /** Live work another Package holds, which a reload would throw away. */
  holds: number;
  now: number;
  /** When this tab last reloaded itself, if it has. */
  reloadedAt?: number;
}

export function deploymentFollowV1(
  input: DeploymentFollowInputV1,
): DeploymentFollowV1 {
  if (!input.stale) return "none";
  const busy =
    input.turnRunning ||
    input.draft.trim().length > 0 ||
    input.overlayOpen ||
    input.listening ||
    input.holds > 0;
  if (busy) return "offer";
  if (
    input.reloadedAt !== undefined &&
    input.now - input.reloadedAt < DEPLOYMENT_RELOAD_INTERVAL_MS_V1
  ) {
    return "offer";
  }
  return "reload";
}

/** The narrowest slice of `sessionStorage` this needs, so a test can pass one. */
export interface DeploymentReloadStoreV1 {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * When this tab last reloaded itself. A missing, unparseable, or absurd value
 * reads as "never": storage can be unavailable or full, and a page that
 * cannot remember should still be able to follow a release once.
 */
export function readDeploymentReloadV1(
  store: DeploymentReloadStoreV1 | undefined,
): number | undefined {
  if (!store) return undefined;
  let raw: string | null;
  try {
    raw = store.getItem(DEPLOYMENT_RELOAD_MARKER_V1);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/**
 * This tab's session storage, or nothing where the browser refuses it. A
 * private window and a blocked-storage setting both throw on the property
 * itself, before any read.
 */
export function deploymentReloadStoreV1(): DeploymentReloadStoreV1 | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function writeDeploymentReloadV1(
  store: DeploymentReloadStoreV1 | undefined,
  now: number,
): void {
  if (!store) return;
  try {
    store.setItem(DEPLOYMENT_RELOAD_MARKER_V1, String(now));
  } catch {
    // A tab that cannot record the reload still reloads. The guard is a
    // safeguard against a loop, not a precondition for following a release.
  }
}
