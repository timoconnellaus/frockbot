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

/**
 * The most one report from a page says, and how many a page sends a minute.
 * A report is a debugging aid for the Bot, never a channel: a page that
 * throws in a loop is heard, not echoed.
 */
export const PLUGIN_PAGE_REPORT_TEXT_MAX_V1 = 500;
export const PLUGIN_PAGE_REPORTS_PER_MINUTE_V1 = 20;
export const PLUGIN_PAGE_REPORT_LEVELS_V1 = ["error", "log"] as const;

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
    }
  | {
      frockbotPage: 1;
      type: "device";
      ability: "microphone";
      status: "open";
      sampleRate: number;
    }
  | {
      frockbotPage: 1;
      type: "device";
      ability: "microphone";
      status: "closed";
      reason: string;
    }
  /** One frame of 16-bit little-endian mono PCM, base64. */
  | { frockbotPage: 1; type: "audio"; pcm: string };

export type PluginPagePageMessageV1 =
  | { frockbotPage: 1; type: "hello" }
  | {
      frockbotPage: 1;
      type: "callTool";
      callId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | { frockbotPage: 1; type: "device"; ability: "microphone"; open: boolean }
  | {
      frockbotPage: 1;
      type: "report";
      level: (typeof PLUGIN_PAGE_REPORT_LEVELS_V1)[number];
      text: string;
    };

/**
 * The page side of the bridge, as `window.frockbot`:
 *
 * - `ready` resolves with `{pluginId, botId, surfaceId, themeTokens, state}`
 *   once the host greets the page, and sets every theme token as a
 *   `--frockbot-<name>` custom property on the document. The host greets each
 *   document when it has loaded, answers `hello` as well, and greets it again
 *   when the Bot's look changes, so a page may be greeted more than once: the
 *   first resolves `ready`, a later one resets the properties and is new state.
 * - `state` is the latest state; `onState(fn)` is called with each new one and
 *   returns its unsubscribe.
 * - `callTool(name, input)` runs one of this Plugin's own tools and resolves
 *   with its text, or rejects with the host's reason.
 * - `openMicrophone(onSamples, onClosed)` asks the host for the microphone
 *   (ADR 0036). It resolves with `{sampleRate, close}` once the host has
 *   opened it, then hands each frame to `onSamples` as a `Float32Array` of
 *   -1..1 mono samples; it rejects with the host's reason when refused, and
 *   `onClosed(reason)` hears the host close it — the person's Stop, the page
 *   leaving the screen, another use of the microphone, or the page's own
 *   `close()`. `close()` resolves once the host has let go; a host that never
 *   answers is taken as having let go after a few seconds.
 *
 * - `frockbot.log(text)` reports a reading to the Bot. The page's errors,
 *   unhandled rejections and `console.error` are reported without asking,
 *   at most twenty a minute and 500 characters each.
 *
 * Only messages from `parent` are read. In a phone WebView the page is its own
 * parent and the host delivers with `window.postMessage`, so the one check
 * serves both renderers.
 */
export const PLUGIN_PAGE_HELPER_JS_V1 = `(() => {
  const V = 1;
  const rec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const listeners = new Set();
  const calls = new Map();
  let n = 0;
  let current = {};
  let ok;
  let fail;
  let mic = null;
  let greeted = false;
  const ready = new Promise((resolve, reject) => {
    ok = resolve;
    fail = reject;
  });
  const post = (m) => parent.postMessage(Object.assign({ frockbotPage: V }, m), "*");
  let reports = 0;
  let minute = 0;
  const report = (level, parts) => {
    const now = Date.now();
    if (now - minute >= 60000) {
      minute = now;
      reports = 0;
    }
    if (reports >= ${PLUGIN_PAGE_REPORTS_PER_MINUTE_V1}) return;
    reports += 1;
    let text;
    try {
      text = parts
        .map((p) => {
          if (typeof p === "string") return p;
          if (!(p instanceof Error)) return JSON.stringify(p);
          const head = String(p);
          const stack = p.stack || "";
          return stack.startsWith(head) ? stack : stack ? head + "\\n" + stack : head;
        })
        .join(" ");
    } catch (_) {
      text = String(parts[0]);
    }
    text = String(text || "").slice(0, ${PLUGIN_PAGE_REPORT_TEXT_MAX_V1});
    if (text) post({ type: "report", level, text });
  };
  addEventListener("error", (e) => report("error", [e.error || e.message || "An error with no message"]));
  addEventListener("unhandledrejection", (e) => report("error", ["Unhandled rejection:", e.reason]));
  const consoleError = console.error;
  console.error = (...args) => {
    report("error", args);
    return consoleError.apply(console, args);
  };
  const pcm = (text) => {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
  };
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!rec(m) || m.frockbotPage !== V) return;
    if (m.type === "init" && rec(m.themeTokens) && rec(m.state)) {
      for (const [k, v] of Object.entries(m.themeTokens)) {
        if (typeof v === "string") document.documentElement.style.setProperty("--frockbot-" + k, v);
      }
      current = m.state;
      if (greeted) {
        for (const fn of listeners) fn(current);
      } else {
        greeted = true;
        ok({ pluginId: m.pluginId, botId: m.botId, surfaceId: m.surfaceId, themeTokens: m.themeTokens, state: m.state });
      }
      return;
    }
    if (m.type === "state" && rec(m.state)) {
      current = m.state;
      for (const fn of listeners) fn(current);
      return;
    }
    if (m.type === "result" && typeof m.callId === "string") {
      const call = calls.get(m.callId);
      if (!call) return;
      calls.delete(m.callId);
      clearTimeout(call.timer);
      if (m.ok === true) call.resolve(String(m.output));
      else call.reject(new Error(String(m.error)));
      return;
    }
    if (m.type === "device" && m.ability === "microphone" && mic) {
      if (m.status === "open" && mic.pending) {
        const opened = mic.pending;
        mic.pending = null;
        opened.resolve({ sampleRate: m.sampleRate, close: () => frockbot.closeMicrophone() });
      } else if (m.status === "closed") {
        const reason = typeof m.reason === "string" ? m.reason : "The microphone was closed.";
        if (mic.pending) {
          const refused = mic.pending;
          mic = null;
          refused.reject(new Error(reason));
        } else {
          ended(mic, reason);
        }
      }
      return;
    }
    if (m.type === "audio" && typeof m.pcm === "string" && mic && !mic.pending && !mic.closing) {
      mic.onSamples(pcm(m.pcm));
    }
  });
  // Once per use, however it ends: the page's own close, the host's, or a
  // host that never answered the page's close.
  const ended = (use, reason) => {
    if (use.over) return;
    use.over = true;
    if (mic === use) mic = null;
    clearTimeout(use.timer);
    if (use.onClosed) use.onClosed(reason);
    if (use.let) use.let();
  };
  const frockbot = {
    ready,
    get state() {
      return current;
    },
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    callTool(tool, input = {}) {
      const callId = "c" + ++n;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(callId);
          reject(new Error("The tool call timed out"));
        }, 60000);
        calls.set(callId, { resolve, reject, timer });
        post({ type: "callTool", callId, tool, input });
      });
    },
    openMicrophone(onSamples, onClosed) {
      if (mic) return Promise.reject(new Error("The microphone is already open."));
      return new Promise((resolve, reject) => {
        mic = { onSamples, onClosed, pending: { resolve, reject } };
        post({ type: "device", ability: "microphone", open: true });
      });
    },
    log(text) {
      report("log", [text]);
    },
    closeMicrophone() {
      const use = mic;
      if (!use) return Promise.resolve();
      if (use.pending) {
        mic = null;
        use.pending.reject(new Error("You stopped the microphone."));
        post({ type: "device", ability: "microphone", open: false });
        return Promise.resolve();
      }
      if (!use.closing) {
        use.closing = new Promise((resolve) => {
          use.let = resolve;
        });
        use.timer = setTimeout(() => ended(use, "You stopped the microphone."), 3000);
        post({ type: "device", ability: "microphone", open: false });
      }
      return use.closing;
    },
  };
  window.frockbot = frockbot;
  post({ type: "hello" });
  setTimeout(() => fail(new Error("FrockBot page init timed out")), 10000);
})();`;

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
    value.type === "device" &&
    keys === "ability,frockbotPage,open,type" &&
    value.ability === "microphone" &&
    typeof value.open === "boolean"
  ) {
    return {
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      open: value.open,
    };
  }
  if (
    value.type === "report" &&
    keys === "frockbotPage,level,text,type" &&
    PLUGIN_PAGE_REPORT_LEVELS_V1.some((level) => level === value.level) &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= PLUGIN_PAGE_REPORT_TEXT_MAX_V1
  ) {
    return {
      frockbotPage: 1,
      type: "report",
      level: value.level as (typeof PLUGIN_PAGE_REPORT_LEVELS_V1)[number],
      text: value.text,
    };
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
