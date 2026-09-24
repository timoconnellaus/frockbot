// A Plugin page: the HTML a `conversation.panel` view may name instead of
// returning a `ViewDocument` (ADR 0036).
//
// The page is untrusted code that runs on the person's device. It is served
// from the app's own origin under `/plugin-pages/`, but never runs as it: the
// response's CSP `sandbox` gives the document an opaque origin however it is
// opened, and the frame's `sandbox` attribute says the same again. It holds no
// credential, may connect nowhere, and reaches the host only through the
// postMessage bridge below. The bridge is injected at publish, so the bytes the
// content hash names are the bytes that run, and a Bot never has to copy a
// helper correctly.

/** A page file in a Plugin's source: one level of directories at most. */
export const PLUGIN_PAGE_PATH_V1 =
  /^(?:[a-z0-9][a-z0-9_-]{0,63}\/)?[a-z0-9][a-z0-9_-]{0,63}\.html$/;

/** The source file's ceiling; it matches the build service's per-file one. */
export const MAX_PLUGIN_PAGE_BYTES_V1 = 512 * 1_024;

/** What a page view's function may hand its page as state. */
export const MAX_PLUGIN_PAGE_STATE_BYTES_V1 = 65_536;

/** Where a stored page lives in the artifact bucket. */
export function pluginPageKeyV1(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("plugin page contentHash is invalid");
  }
  return `plugin-pages/${contentHash}.html`;
}

/** The app-origin path a stored page is served at. */
export const PLUGIN_PAGE_ROUTE_V1 = /^\/plugin-pages\/([0-9a-f]{64})\.html$/;

export function pluginPageUrlV1(
  appOrigin: string,
  contentHash: string,
): string {
  return `${appOrigin}/${pluginPageKeyV1(contentHash)}`;
}

/** One page a Composition member carries, by the path its views name. */
export interface PluginPageArtifactV1 {
  path: string;
  /** sha-256 hex of the stored page, bridge included. */
  contentHash: string;
  size: number;
}

/** The bridge version a page speaks; carried on every message both ways. */
export const PLUGIN_PAGE_BRIDGE_VERSION_V1 = 1 as const;

/** A tool call's id, minted by the page and echoed on its result. */
export const PLUGIN_PAGE_CALL_ID_V1 = /^[A-Za-z0-9_-]{1,64}$/;

export type PluginPageHostMessageV1 =
  | {
      frockbotPage: 1;
      type: "init";
      pluginId: string;
      botId: string;
      surfaceId: string;
      themeTokens: Record<string, string>;
      state: Record<string, unknown>;
    }
  | { frockbotPage: 1; type: "state"; state: Record<string, unknown> }
  | {
      frockbotPage: 1;
      type: "result";
      callId: string;
      ok: true;
      output: string;
    }
  | {
      frockbotPage: 1;
      type: "result";
      callId: string;
      ok: false;
      error: string;
    };

export type PluginPagePageMessageV1 =
  | { frockbotPage: 1; type: "hello" }
  | {
      frockbotPage: 1;
      type: "callTool";
      callId: string;
      tool: string;
      input: Record<string, unknown>;
    };

/**
 * The page side of the bridge, as `window.frockbot`:
 *
 * - `ready` resolves with `{pluginId, botId, surfaceId, themeTokens, state}`
 *   once the host answers the page's `hello`, and sets every theme token as a
 *   `--frockbot-<name>` custom property on the document.
 * - `state` is the latest state; `onState(fn)` is called with each new one and
 *   returns its unsubscribe.
 * - `callTool(name, input)` runs one of this Plugin's own tools and resolves
 *   with its text, or rejects with the host's reason.
 *
 * Only messages from `parent` are read. In a phone WebView the page is its own
 * parent and the host delivers with `window.postMessage`, so the one check
 * serves both renderers.
 */
export const PLUGIN_PAGE_HELPER_JS_V1 = `(()=>{const V=1,rec=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),S=new Set(),C=new Map();let n=0,current={},ok,fail;const ready=new Promise((r,j)=>{ok=r;fail=j}),post=m=>parent.postMessage(Object.assign({frockbotPage:V},m),'*');addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data;if(!rec(m)||m.frockbotPage!==V)return;if(m.type==='init'&&rec(m.themeTokens)&&rec(m.state)){for(const [k,v] of Object.entries(m.themeTokens))if(typeof v==='string')document.documentElement.style.setProperty('--frockbot-'+k,v);current=m.state;ok({pluginId:m.pluginId,botId:m.botId,surfaceId:m.surfaceId,themeTokens:m.themeTokens,state:m.state});return}if(m.type==='state'&&rec(m.state)){current=m.state;for(const fn of S)fn(current);return}if(m.type==='result'&&typeof m.callId==='string'){const c=C.get(m.callId);if(!c)return;C.delete(m.callId);clearTimeout(c.t);m.ok===true?c.r(String(m.output)):c.j(new Error(String(m.error)))}});window.frockbot={ready,get state(){return current},onState(fn){S.add(fn);return()=>S.delete(fn)},callTool(tool,input={}){const callId='c'+(++n);return new Promise((r,j)=>{const t=setTimeout(()=>{C.delete(callId);j(new Error('The tool call timed out'))},60000);C.set(callId,{r,j,t});post({type:'callTool',callId,tool,input})})}};post({type:'hello'});setTimeout(()=>fail(new Error('FrockBot page init timed out')),10000)})();`;

const HEAD = /<head(?:\s[^>]*)?>/i;
const HTML = /<html(?:\s[^>]*)?>/i;

/**
 * The page as stored: the bridge helper first in `<head>`, so it is listening
 * before any of the page's own script runs. A page with no `<head>` gets it
 * after `<html>`, and a fragment gets it at the top.
 */
export function withPluginPageBridgeV1(html: string): string {
  const script = `<script>${PLUGIN_PAGE_HELPER_JS_V1}</script>`;
  for (const tag of [HEAD, HTML]) {
    const match = tag.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + script + html.slice(at);
    }
  }
  return script + html;
}

/** The page's own message, decoded exactly, or undefined for anything else. */
export function decodePluginPageMessageV1(
  input: unknown,
): PluginPagePageMessageV1 | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (value.frockbotPage !== PLUGIN_PAGE_BRIDGE_VERSION_V1) return undefined;
  const keys = Object.keys(value).sort().join(",");
  if (value.type === "hello" && keys === "frockbotPage,type") {
    return { frockbotPage: 1, type: "hello" };
  }
  if (
    value.type === "callTool" &&
    keys === "callId,frockbotPage,input,tool,type" &&
    typeof value.callId === "string" &&
    PLUGIN_PAGE_CALL_ID_V1.test(value.callId) &&
    typeof value.tool === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(value.tool) &&
    value.input !== null &&
    typeof value.input === "object" &&
    !Array.isArray(value.input)
  ) {
    return {
      frockbotPage: 1,
      type: "callTool",
      callId: value.callId,
      tool: value.tool,
      input: value.input as Record<string, unknown>,
    };
  }
  return undefined;
}

/**
 * A page view's state, checked: a JSON object within the budget. Anything else
 * is the page's failure, said in words.
 */
export function pluginPageStateV1(
  value: unknown,
): { state: Record<string, unknown> } | { failure: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { failure: "the page's view must return an object" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { failure: "the page's state is not JSON" };
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_PLUGIN_PAGE_STATE_BYTES_V1
  ) {
    return {
      failure: `the page's state is larger than ${MAX_PLUGIN_PAGE_STATE_BYTES_V1} bytes`,
    };
  }
  return { state: JSON.parse(serialized) as Record<string, unknown> };
}
