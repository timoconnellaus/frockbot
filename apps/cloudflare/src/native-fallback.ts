const ARTIFACT_ORIGIN = "https://ui.bot.frockbot.com";

/**
 * The theme an Applet is told about on the phone. The hosted shell reads the
 * same names off its stylesheet at runtime; the native page has no stylesheet
 * to read, so these are the Frock UI dark, phone-density values written out
 * (docs/design/tokens.json: window, tile, sheet, ink, line, accent, and the
 * phone radii). The Applet kit falls back to its light defaults for any name
 * that is missing, which is what an off-brand Applet on the phone looks like.
 */
export const NATIVE_APPLET_THEME_TOKENS_V1: Readonly<Record<string, string>> =
  Object.freeze({
    surface: "#1b1a20",
    "surface-raised": "#2b282f",
    "surface-subtle": "#221f27",
    text: "rgb(244 242 246 / 92%)",
    "text-muted": "rgb(244 242 246 / 60%)",
    border: "rgb(244 242 246 / 8%)",
    accent: "#ec386b",
    "accent-surface": "rgb(236 56 107 / 14%)",
    "accent-text": "#f3a3ba",
    "on-accent": "#ffffff",
    danger: "#ef9aa5",
    "danger-surface": "rgb(239 154 165 / 14%)",
    success: "#7cc9a6",
    "success-surface": "rgb(124 201 166 / 14%)",
    warning: "#dfc07f",
    "warning-surface": "rgb(223 192 127 / 14%)",
    "focus-ring": "rgb(236 56 107 / 34%)",
    "radius-control": "14px",
    "radius-card": "18px",
  });

/** Anonymous reviewed bootstrap. It has no application cookie/session door. */
export function nativeFallbackResponse(request: Request): Response {
  const url = new URL(request.url);
  const artifact = url.searchParams.get("artifact");
  const epoch = url.searchParams.get("epoch");
  if (
    request.method !== "GET" ||
    url.origin !== ARTIFACT_ORIGIN ||
    url.pathname !== "/native-fallback" ||
    !artifact ||
    !/^[a-f0-9]{64}$/.test(artifact) ||
    !epoch ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(epoch) ||
    [...url.searchParams.keys()].sort().join() !== "artifact,epoch"
  )
    return new Response("This Applet couldn’t be opened.", { status: 400 });
  const source = `${ARTIFACT_ORIGIN}/packages/${artifact}.html`;
  const nonce = crypto.randomUUID();
  const script = `(() => {
    const epoch = ${JSON.stringify(epoch)};
    const frame = document.getElementById('applet');
    let ready = false, closed = false, loads = 0;
    frame.addEventListener('load', () => { if (++loads > 1) { closed = true; ready = false; } });
    window.addEventListener('message', event => {
      if (closed || event.source !== frame.contentWindow) return;
      const m = event.data;
      if (m && typeof m === 'object' && Object.keys(m).sort().join() === 'schemaVersion,tokenTransport,type' && m.schemaVersion === 1 && m.type === 'applet/ready' && m.tokenTransport === 'subprotocol-v1') ready = true;
    });
    Object.defineProperty(window, 'frockbotFallback', {value:Object.freeze({
      ready: () => !closed && ready ? epoch : null,
      provide: (expectedEpoch, applet) => {
        if (closed || !ready || expectedEpoch !== epoch || !applet || applet.tokenTransport !== 'subprotocol-v1') return false;
        frame.contentWindow.postMessage({schemaVersion:1,type:'init',themeTokens:${JSON.stringify(NATIVE_APPLET_THEME_TOKENS_V1)},applet}, '*');
        return true;
      },
      close: () => { closed = true; ready = false; frame.remove(); }
    })});
    frame.src = ${JSON.stringify(source)};
  })();`;
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">html,body,iframe{margin:0;width:100%;height:100%;border:0;background:${NATIVE_APPLET_THEME_TOKENS_V1.surface}}body{overflow:hidden}</style></head><body><iframe id="applet" title="Applet" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">${script}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "permissions-policy":
          "camera=(), microphone=(), geolocation=(), payment=(), clipboard-read=(), clipboard-write=()",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src ${source}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
      },
    },
  );
}
