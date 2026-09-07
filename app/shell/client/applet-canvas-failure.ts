/**
 * One honest state per way an Applet read can fail.
 *
 * The canvas used to put whatever string reached its `catch` on screen and
 * keep polling. A permanent 503 — the deployment could not sign a viewer
 * token — therefore read as "Couldn't reach FrockBot." on the first attempt
 * and "That didn't work." on the next, forever, while nothing about it was
 * ever going to change (2026-09-05).
 *
 * So a failure is classified once, into a sentence that says which of four
 * things happened, and a retry policy that matches: a network that might come
 * back is retried on a widening backoff, and a refusal the deployment has
 * already settled is not retried at all.
 */
import { classifyClientFailureV1 } from "@frockbot/client-core";

export type AppletCanvasFailureKindV1 =
  | "offline"
  | "unreachable"
  | "unavailable"
  | "unpublished"
  | "denied"
  | "refused";

export interface AppletCanvasFailureV1 {
  readonly kind: AppletCanvasFailureKindV1;
  /** The one sentence the panel shows. */
  readonly message: string;
  /**
   * `auto` retries on the backoff below and offers the button as well;
   * `manual` waits for the User, because retrying changes nothing.
   */
  readonly retry: "auto" | "manual";
  /** The raw text, for the console and for tests. Never for the screen. */
  readonly detail: string;
}

/** How long to wait before the nth automatic retry, in milliseconds. */
export function appletCanvasRetryDelayMsV1(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(attempt - 1, 0), 30_000);
}

/** After this many automatic attempts the panel stops and waits for the User. */
export const APPLET_CANVAS_MAX_AUTO_RETRIES_V1 = 4;

/**
 * What a caught Applet read amounts to.
 *
 * `definitive` is the deployment saying this outcome is settled — the shape
 * the Applet routes use for a 503 that configuration, not weather, caused. It
 * is the difference between "try again in a moment" and "this will not work
 * until somebody fixes the deployment", and the panel must not confuse them.
 */
export function appletCanvasFailureV1(error: unknown): AppletCanvasFailureV1 {
  const failure = classifyClientFailureV1(error);
  const detail = failure.detail;
  const definitive =
    typeof error === "object" &&
    error !== null &&
    (error as { definitive?: unknown }).definitive === true;
  if (failure.kind === "offline") {
    return {
      kind: "offline",
      message: "You're offline. This Applet opens when you reconnect.",
      retry: "manual",
      detail,
    };
  }
  if (failure.kind === "denied") {
    return {
      kind: "denied",
      message: "You're not signed in any more. Sign in again to open this.",
      retry: "manual",
      detail,
    };
  }
  if (failure.kind === "missing") {
    return {
      kind: "unpublished",
      message: "This Applet hasn't been published yet.",
      retry: "manual",
      detail,
    };
  }
  if (definitive || failure.kind === "server") {
    // The deployment answered, and what it answered was that Applets do not
    // work here. Nothing the User can do makes that untrue, so the panel says
    // so once and stops.
    return {
      kind: "unavailable",
      message: "Applets are unavailable right now. This one is at our end.",
      retry: "manual",
      detail,
    };
  }
  if (failure.kind === "unreachable") {
    return {
      kind: "unreachable",
      message: "FrockBot didn't answer.",
      retry: "auto",
      detail,
    };
  }
  return {
    kind: "refused",
    // A 4xx is the deployment explaining a rule it holds, so its own sentence
    // is the User's to read when it wrote one.
    message: failure.serverMessage ?? "FrockBot wouldn't open this Applet.",
    retry: "manual",
    detail,
  };
}
