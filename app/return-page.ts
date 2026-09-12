// The branded page a person lands on in their browser when a hosted flow
// hands them back to FrockBot: the app's own sign-in, or an app's sign-in
// through Connect. One template, so every return reads as one product.
//
// The page loads nothing from anywhere: the icon is inlined, the styles are
// inlined under a nonce, and a script runs only where a caller supplies one —
// the Mac app's custom-scheme hand-off — under the same nonce. Nothing a
// caller passes is reflected without escaping.
import { RETURN_PAGE_LOGO_V1 } from "./return-page-logo.js";

export { RETURN_PAGE_LOGO_V1 };

export interface ReturnPageV1 {
  /** The document title. */
  title: string;
  heading: string;
  lead: string;
  /** The animated "opening…" pill, shown while a script hands over. */
  status?: string;
  /** The one button on the page. */
  action?: { label: string; href: string; id?: string };
  footnote: string;
  /**
   * Inline script, run under the page's nonce. It must never reflect the
   * query into markup; the sign-in return forwards two named parameters only.
   */
  script?: string;
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function returnPageV1(page: ReturnPageV1): Response {
  const nonce = crypto.randomUUID();
  const status =
    page.status === undefined
      ? ""
      : `
  <div class="status" role="status"><span class="dots"><i></i><i></i><i></i></span>${escape(page.status)}</div>`;
  const action =
    page.action === undefined
      ? ""
      : `
  <a class="open"${page.action.id === undefined ? "" : ` id="${escape(page.action.id)}"`} href="${escape(page.action.href)}">${escape(page.action.label)}</a>`;
  const script =
    page.script === undefined
      ? ""
      : `
<script nonce="${nonce}">
${page.script}
</script>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#1f1e24">
<title>${escape(page.title)}</title>
<style nonce="${nonce}">
  :root {
    --window: #1f1e24; --raised: #2c2a33; --border: #3a3742;
    --text: #f4f2f6; --muted: #aaa6b1; --accent: #ec386b; --accent-hover: #f04d7b;
    --glow: rgba(236, 56, 107, .22); --shadow: rgba(0, 0, 0, .45);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --window: #faf8fb; --raised: #ffffff; --border: #dfd9e3;
      --text: #1f1e24; --muted: #625c6b; --accent: #bd1e50; --accent-hover: #d02a5f;
      --glow: rgba(189, 30, 80, .14); --shadow: rgba(31, 30, 36, .12);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 24px;
    background: var(--window) radial-gradient(60rem 30rem at 50% -10%, var(--glow), transparent 70%);
    color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Manrope, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%; max-width: 26.5rem; padding: 2.5rem 2rem 2rem; text-align: center;
    background: var(--raised); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: 0 24px 60px -24px var(--shadow);
    animation: rise .5s cubic-bezier(.2, .8, .2, 1) both;
  }
  .icon {
    display: block; width: 88px; height: 88px; margin: 0 auto 1.25rem; border-radius: 24px;
    box-shadow: 0 10px 30px -10px var(--shadow);
  }
  .brand {
    margin: 0 0 .75rem; font-size: .8125rem; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: var(--accent);
  }
  h1 { margin: 0 0 .625rem; font-size: 1.5rem; line-height: 1.2; letter-spacing: -.01em; }
  p { margin: 0 0 1.5rem; color: var(--muted); }
  .status {
    display: inline-flex; align-items: center; gap: .625rem; margin-bottom: 1.5rem;
    padding: .5rem .9rem; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--text); font-size: .9375rem; font-weight: 600;
  }
  .dots { display: inline-flex; gap: 4px; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: .2s; }
  .dots i:nth-child(3) { animation-delay: .4s; }
  a.open {
    display: block; padding: .9rem 1.5rem; border-radius: 12px; background: var(--accent); color: #fff;
    font-weight: 700; text-decoration: none; transition: background .14s ease, transform .14s ease;
  }
  a.open:hover { background: var(--accent-hover); }
  a.open:active { transform: translateY(1px); }
  a.open:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  small { display: block; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .875rem; line-height: 1.5; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @keyframes pulse { 0%, 80%, 100% { opacity: .25; transform: scale(.8); } 40% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { main, .dots i { animation: none; } }
</style>
</head>
<body>
<main>
  <img class="icon" src="${RETURN_PAGE_LOGO_V1}" alt="" width="88" height="88">
  <p class="brand">FrockBot</p>
  <h1>${escape(page.heading)}</h1>
  <p>${escape(page.lead)}</p>${status}${action}
  <small>${escape(page.footnote)}</small>
</main>${script}
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; img-src data:; ${page.script === undefined ? "" : `script-src 'nonce-${nonce}'; `}style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}
