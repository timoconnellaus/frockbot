const ARTIFACT_ORIGIN = "https://ui.bot.frockbot.com";

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
        frame.contentWindow.postMessage({schemaVersion:1,type:'init',themeTokens:{'surface':'#211f26','text':'#f4f2f6','accent':'#ec386b'},applet}, '*');
        return true;
      },
      close: () => { closed = true; ready = false; frame.remove(); }
    })});
    frame.src = ${JSON.stringify(source)};
  })();`;
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#211f26}body{overflow:hidden}</style></head><body><iframe id="applet" title="Applet" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">${script}</script></body></html>`,
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
