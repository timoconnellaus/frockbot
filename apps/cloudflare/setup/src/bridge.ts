/**
 * The page's side of the app's frame (`host_frame.dart`).
 *
 * The app frames Setup on the web in an iframe, and on a phone or a Mac in a
 * web view whose host listens to the page's own `postMessage`. Either way the
 * page says one small vocabulary, each message tagged `frockbotSetup: 1`:
 *
 * - `ready`: the page has drawn and can take messages.
 * - `renew`: the reader credential expired; the app answers `reader`.
 * - `open {url}`: a payment page, in the person's own browser.
 * - `connect {packageId, connectionTypeId, commandId}` and
 *   `mcp-sign-in {connectionId, commandId}`: an app's or a server's sign-in,
 *   which the app opens so it can come back to itself; it answers `door`.
 * - `close`: back to the Bots.
 *
 * The app's messages are tagged `frockbotSetupHost: 1`: `reader`, `door`,
 * and `refresh` when something may have changed while the page was hidden.
 */

type HostMessage = Record<string, unknown> & { type: string };

const FRAMED_KEY = "frockbot-setup-framed";

let framed = false;

export function adoptFrame(fromApp: boolean): void {
  try {
    if (fromApp) sessionStorage.setItem(FRAMED_KEY, "1");
    framed = fromApp || sessionStorage.getItem(FRAMED_KEY) === "1";
  } catch {
    framed = fromApp;
  }
}

/** Opened by the app, rather than in a tab of its own. */
export function framedByApp(): boolean {
  return framed;
}

export function tellHost(message: HostMessage): void {
  if (!framed) return;
  const data = { frockbotSetup: 1, ...message };
  if (window.parent !== window) {
    window.parent.postMessage(data, location.origin);
  } else {
    // The phone's and the Mac's web view forward the page's own messages.
    window.postMessage(data, location.origin);
  }
}

const listeners = new Set<(message: HostMessage) => void>();

window.addEventListener("message", (event) => {
  const fromParent = window.parent !== window && event.source === window.parent;
  // A web view's host delivers a synthetic event on the page's own window.
  const fromWebView =
    window.parent === window && !event.isTrusted && event.source === window;
  if (!fromParent && !fromWebView) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data.frockbotSetupHost !== 1 || typeof data.type !== "string")
    return;
  for (const listener of listeners) listener(data as HostMessage);
});

export function onHost(listener: (message: HostMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the app something and waits for the one answer of type `reply`. */
export function askHost(
  message: HostMessage,
  reply: string,
  timeoutMs: number,
): Promise<HostMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The app did not answer"));
    }, timeoutMs);
    const stop = onHost((answer) => {
      if (answer.type !== reply) return;
      clearTimeout(timer);
      stop();
      resolve(answer);
    });
    tellHost(message);
  });
}
