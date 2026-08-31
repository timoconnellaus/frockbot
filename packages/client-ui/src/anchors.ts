/**
 * The client-side half of the settings deep-link scheme.
 *
 * The scheme itself lives in `@frockbot/plugin-shell/settings-links`, which
 * `client-ui` must not depend on — a primitive cannot import the shell. What
 * the primitives need is narrower: the name of the event the shell fires when
 * a link resolves, so an anchored row can highlight itself without either side
 * reaching into the other's styles.
 */

/** The window event a resolved settings link fires. `detail` is the anchor. */
export const UI_ANCHOR_EVENT = "frockbot:anchor";

export type UiAnchorEvent = CustomEvent<string>;

/** Tell every mounted anchor that this one is the link's target. */
export function announceUiAnchor(anchor: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(UI_ANCHOR_EVENT, { detail: anchor }));
}

/** How long an anchored row stays highlighted after a link resolves to it. */
export const UI_ANCHOR_HIGHLIGHT_MS = 2_600;
