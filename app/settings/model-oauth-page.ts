import {
  decodeConnectionCommandV1,
  decodeConnectionCommandReceiptV1,
} from "@frockbot/core/connection";
import { decodeStartConnectionCommandV1 } from "@frockbot/core/configuration";
import type { SettingsConnectionGatewayHost } from "./backend.js";
function html(body: string, script = "") {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to FrockBot</title><style nonce="${nonce}">body{font:17px system-ui;background:#faf8f4;color:#242323;max-width:38rem;margin:10vh auto;padding:24px}button,a,input,textarea{font:inherit;padding:12px;margin:8px 0}input,textarea{box-sizing:border-box;width:100%}button{cursor:pointer}#code{font-size:2rem}a{display:block}small{display:block}</style><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      },
    },
  );
}
/** The link grants access only to its expiring sign-in attempt, never to model credentials. */
export async function routeModelOAuthV1(
  host: SettingsConnectionGatewayHost,
  request: Request,
  url: URL,
  userId?: string,
): Promise<Response | undefined> {
  const start = /^\/api\/plugins\/(provider-[a-z0-9-]+)\/connections$/.exec(
    url.pathname,
  );
  if (start && request.method === "POST" && userId) {
    const command = decodeStartConnectionCommandV1(
      await request.clone().json(),
    );
    if (command.connectionTypeId !== `${start[1]!.slice(9)}-oauth`)
      return undefined;
    const receipt = decodeConnectionCommandReceiptV1(
      await host.executeConnection(userId, {
        schemaVersion: 1,
        type: "connection/oauth",
        action: "start",
        packageId: start[1]!,
        commandId: command.commandId,
        attemptId: command.commandId,
        ...(command.alias ? { label: command.alias } : {}),
        callbackUrl: `${url.origin}/api/model-oauth/callback`,
      }),
    );
    if (receipt.oauth?.status === "ready")
      return Response.json({
        schemaVersion: 1,
        status: "ready",
        connectionId: receipt.connectionId,
      });
    if (!receipt.oauth?.browserKey) throw new Error("Sign-in could not start");
    const page = new URL("/api/model-oauth", url);
    page.hash = new URLSearchParams({
      userId,
      packageId: start[1]!,
      attemptId: command.commandId,
      browserKey: receipt.oauth.browserKey,
    }).toString();
    return Response.json({
      schemaVersion: 1,
      status: "authorization-required",
      connectionId: receipt.connectionId,
      redirectUrl: page.href,
      expiresAt: new Date(receipt.oauth.expiresAt!).toISOString(),
    });
  }
  if (url.pathname === "/api/model-oauth" && request.method === "GET") {
    return html(
      `<h1>Connect your account</h1><p id="status">Loading sign-in…</p><strong id="code"></strong><a id="signin" hidden target="_blank" rel="noopener noreferrer">Open provider sign-in</a><div id="manual" hidden><label>Return URL<textarea id="returnUrl" rows="4" placeholder="Paste the return URL after signing in"></textarea></label><button id="finish">Finish connecting</button></div><button id="cancel">Cancel sign-in</button><small>When connected, return to FrockBot. Your models are shared across your Bots.</small>`,
      `
const q=new URLSearchParams(location.hash.slice(1));let base={userId:q.get('userId'),packageId:q.get('packageId'),attemptId:q.get('attemptId'),browserKey:q.get('browserKey')};
try{if(base.browserKey)sessionStorage.setItem('frockbot-oauth-page',JSON.stringify(base));else base=JSON.parse(sessionStorage.getItem('frockbot-oauth-page')||'null')||base;}catch{}
history.replaceState(null,'',location.pathname);
let finished=false,busy=false;
async function step(action,code){if(busy||finished)return;busy=true;try{const r=await fetch('/api/model-oauth/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,action,...(code?{code}:{})})});const data=await r.json();if(!r.ok)throw Error(data.error||'Sign-in could not finish');const p=data.oauth;if(!p)throw Error('Sign-in progress unavailable');document.getElementById('status').textContent=p.status==='ready'?'Account connected. Return to FrockBot.':p.status==='waiting'?'Sign in with your provider to continue.':p.message||'Sign-in cancelled.';finished=p.status!=='waiting';if(finished){try{sessionStorage.removeItem('frockbot-oauth-page');}catch{}}const a=document.getElementById('signin');a.hidden=!p.authorizationUrl||finished;if(p.authorizationUrl){const u=new URL(p.authorizationUrl);if(u.protocol!=='https:')throw Error('Invalid sign-in URL');a.href=u.href;}document.getElementById('code').textContent=finished?'':p.userCode||'';document.getElementById('manual').hidden=!p.manualCode||finished;document.getElementById('cancel').hidden=finished;}catch(e){document.getElementById('status').textContent=e.message;finished=true;}finally{busy=false;}}
document.getElementById('finish').onclick=()=>step('complete',document.getElementById('returnUrl').value);document.getElementById('cancel').onclick=()=>step('cancel');step('check');setInterval(()=>step('check'),5000);`,
    );
  }
  if (
    url.pathname === "/api/model-oauth/progress" &&
    request.method === "POST"
  ) {
    const v = (await request.json()) as Record<string, unknown>;
    if (
      !v ||
      Object.keys(v).some(
        (k) =>
          ![
            "userId",
            "packageId",
            "attemptId",
            "browserKey",
            "action",
            "code",
          ].includes(k),
      ) ||
      typeof v.userId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(v.userId) ||
      typeof v.browserKey !== "string" ||
      v.browserKey.length < 64 ||
      !["check", "complete", "cancel"].includes(v.action as string)
    )
      throw new Error("Invalid sign-in request");
    const command = decodeConnectionCommandV1({
      schemaVersion: 1,
      type: "connection/oauth",
      commandId: crypto.randomUUID(),
      packageId: v.packageId,
      attemptId: v.attemptId,
      browserKey: v.browserKey,
      action: v.action,
      ...(v.code === undefined ? {} : { code: v.code }),
    });
    return Response.json(
      decodeConnectionCommandReceiptV1(
        await host.executeConnection(v.userId, command),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    url.pathname === "/api/model-oauth/callback" &&
    request.method === "GET"
  ) {
    const escaped = url.href
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
    return html(
      `<h1>Return to FrockBot</h1><p>Copy this return URL into the sign-in box to finish connecting your account.</p><textarea readonly rows="6">${escaped}</textarea>`,
    );
  }
  return undefined;
}
