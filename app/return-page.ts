// The branded page a person lands on in their browser when a hosted flow
// hands them back to FrockBot: the app's own sign-in, or an app's sign-in
// through Connect. One template, so every return reads as one product.
//
// The page loads nothing from anywhere: the icon is inlined, the styles are
// inlined under a nonce, and a script runs only where a caller supplies one —
// the Mac app's custom-scheme hand-off — under the same nonce. Nothing a
// caller passes is reflected without escaping, and no page can be framed.
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
  /**
   * A button that posts `fields` to `action` on this origin, in place of a
   * link: the press a page waits for before it acts. `redirects` names the
   * CSP sources off this origin that the post's answer may send the browser
   * to; the page's own origin is always allowed.
   */
  form?: {
    label: string;
    action: string;
    fields: Readonly<Record<string, string>>;
    redirects?: readonly string[];
  };
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
  const fields = Object.entries(page.form?.fields ?? {})
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
    )
    .join("");
  const form =
    page.form === undefined
      ? ""
      : `
  <form method="post" action="${escape(page.form.action)}">${fields}<button class="open" type="submit">${escape(page.form.label)}</button></form>`;
  // A form's post must carry its Origin, which a no-referrer page sends as
  // "null"; the page loads nothing from any other origin either way.
  const referrer = page.form === undefined ? "no-referrer" : "same-origin";
  const formAction =
    page.form === undefined
      ? "form-action 'none'"
      : ["form-action 'self'", ...(page.form.redirects ?? [])].join(" ");
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
<meta name="referrer" content="${referrer}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#15151e">
<title>${escape(page.title)}</title>
<style nonce="${nonce}">
  :root {
    --window: #15151e; --raised: #1f202e; --border: #2c2d3d;
    --text: #f1f1f6; --muted: #a0a2b6; --accent: #d92d71; --accent-hover: #de4b83;
    --shadow: rgba(0, 0, 0, .45);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --window: #f5f6f9; --raised: #ffffff; --border: #dfe1e8;
      --text: #15151e; --muted: #5c5f70; --accent: #d3266d; --accent-hover: #b9205e;
      --shadow: rgba(21, 20, 22, .12);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 24px;
    background: var(--window);
    color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Manrope, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%; max-width: 26.5rem; overflow-wrap: anywhere; padding: 2.5rem 2rem 2rem; text-align: center;
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
  form { margin: 0; }
  .open {
    display: block; width: 100%; padding: .9rem 1.5rem; border: 0; border-radius: 12px; background: var(--accent); color: #fff;
    font: inherit; font-weight: 700; text-decoration: none; cursor: pointer; transition: background .14s ease, transform .14s ease;
  }
  .open:hover { background: var(--accent-hover); }
  .open:active { transform: translateY(1px); }
  .open:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
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
  <p>${escape(page.lead)}</p>${status}${action}${form}
  <small>${escape(page.footnote)}</small>
</main>${script}
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": referrer,
      "content-security-policy": `default-src 'none'; img-src data:; ${page.script === undefined ? "" : `script-src 'nonce-${nonce}'; `}style-src 'nonce-${nonce}'; base-uri 'none'; ${formAction}; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
