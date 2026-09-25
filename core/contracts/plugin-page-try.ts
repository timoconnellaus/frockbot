// Trying a Plugin's page before it is published (ADR 0036, step 10).
//
// A Bot cannot open its page on the person's device, and the tuner showed
// what that costs: a Stop that jammed and a threshold a guitar never reached,
// both found by the person. So the Bot tries the page on its own Computer, in
// a headless browser, beside a stand-in host that speaks the same bridge the
// app does. The stand-in and the runner belong to the platform and are sent
// with each try, so they are always this release's, never the Bot's.

import {
  PLUGIN_PAGE_BRIDGE_VERSION_V1,
  PLUGIN_PAGE_REPORT_TEXT_MAX_V1,
} from "./plugin-page.js";

/** How many steps one try may take, and how long it may wait in all. */
export const PLUGIN_PAGE_TRY_MAX_STEPS_V1 = 30;
export const PLUGIN_PAGE_TRY_MAX_WAIT_MS_V1 = 30_000;
/** How many pictures one try hands back, and the most each may weigh. */
export const PLUGIN_PAGE_TRY_MAX_SCREENSHOTS_V1 = 4;
export const PLUGIN_PAGE_TRY_SHOT_MAX_BYTES_V1 = 20_000;
/** How long a try's steps may run, and how much its result may weigh. */
export const PLUGIN_PAGE_TRY_DEADLINE_MS_V1 = 90_000;
export const PLUGIN_PAGE_TRY_RESULT_MAX_BYTES_V1 = 24_000;
const PLUGIN_PAGE_TRY_ERROR_MAX_V1 = 300;

export type PluginPageTryStepV1 =
  /** Clicks the first element the CSS selector finds in the page. */
  | { click: string }
  /** The microphone hears a tone from now on: hertz, loudness 0–1, noise 0–1. */
  | { tone: { frequency: number; level: number; noise?: number } }
  /** The microphone hears nothing from now on. */
  | { silence: true }
  /** The person presses the host bar's Stop. */
  | { hostStop: true }
  /** The page is handed new state, as after one of its tools ran. */
  | { state: Record<string, unknown> }
  | { wait: number }
  /** A picture of the page as it is now, under this label. */
  | { screenshot: string };

export interface PluginPageTryRequestV1 {
  steps: PluginPageTryStepV1[];
  state: Record<string, unknown>;
  /** What each of the Plugin's tools answers when the page calls it. */
  toolAnswers: Record<string, string>;
}

export class PluginPageTryDecodeError extends Error {}

function fail(message: string): never {
  throw new PluginPageTryDecodeError(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unit(value: unknown, name: string): number {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    fail(`${name} must be a number from 0 to 1`);
  }
  return value;
}

function decodeStep(value: unknown, index: number): PluginPageTryStepV1 {
  if (!record(value) || Object.keys(value).length !== 1) {
    fail(`step ${index + 1} must be an object with exactly one action`);
  }
  if ("click" in value) {
    const selector = value.click;
    if (
      typeof selector !== "string" ||
      selector.length === 0 ||
      selector.length > 200
    ) {
      fail(`step ${index + 1}: click takes a CSS selector`);
    }
    return { click: selector };
  }
  if ("tone" in value) {
    const tone = value.tone;
    if (!record(tone)) fail(`step ${index + 1}: tone takes an object`);
    const frequency = tone.frequency;
    if (
      typeof frequency !== "number" ||
      !(frequency >= 20 && frequency <= 4_000)
    ) {
      fail(`step ${index + 1}: tone.frequency must be 20 to 4000 Hz`);
    }
    return {
      tone: {
        frequency,
        level: unit(tone.level, `step ${index + 1}: tone.level`),
        ...(tone.noise === undefined
          ? {}
          : { noise: unit(tone.noise, `step ${index + 1}: tone.noise`) }),
      },
    };
  }
  if ("silence" in value) {
    if (value.silence !== true) fail(`step ${index + 1}: silence takes true`);
    return { silence: true };
  }
  if ("hostStop" in value) {
    if (value.hostStop !== true) fail(`step ${index + 1}: hostStop takes true`);
    return { hostStop: true };
  }
  if ("state" in value) {
    if (!record(value.state)) fail(`step ${index + 1}: state takes an object`);
    return { state: value.state };
  }
  if ("wait" in value) {
    const wait = value.wait;
    if (typeof wait !== "number" || !(wait >= 0 && wait <= 10_000)) {
      fail(`step ${index + 1}: wait must be 0 to 10000 ms`);
    }
    return { wait };
  }
  if ("screenshot" in value) {
    const label = value.screenshot;
    if (typeof label !== "string" || label.length === 0 || label.length > 80) {
      fail(`step ${index + 1}: screenshot takes a short label`);
    }
    return { screenshot: label };
  }
  return fail(
    `step ${index + 1}: the action must be click, tone, silence, hostStop, state, wait or screenshot`,
  );
}

/** A Bot's try, checked: bounded, and only the actions the stand-in knows. */
export function decodePluginPageTryRequestV1(input: {
  steps?: unknown;
  state?: unknown;
  toolAnswers?: unknown;
}): PluginPageTryRequestV1 {
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    fail("steps must be a non-empty list");
  }
  if (steps.length > PLUGIN_PAGE_TRY_MAX_STEPS_V1) {
    fail(`at most ${PLUGIN_PAGE_TRY_MAX_STEPS_V1} steps`);
  }
  const decoded = steps.map(decodeStep);
  const waited = decoded.reduce(
    (total, step) => total + ("wait" in step ? step.wait : 0),
    0,
  );
  if (waited > PLUGIN_PAGE_TRY_MAX_WAIT_MS_V1) {
    fail(`the waits add up to more than ${PLUGIN_PAGE_TRY_MAX_WAIT_MS_V1} ms`);
  }
  if (
    decoded.filter((step) => "screenshot" in step).length >
    PLUGIN_PAGE_TRY_MAX_SCREENSHOTS_V1
  ) {
    fail(`at most ${PLUGIN_PAGE_TRY_MAX_SCREENSHOTS_V1} screenshots`);
  }
  const state = input.state ?? {};
  if (!record(state)) fail("state must be an object");
  const answers = input.toolAnswers ?? {};
  if (
    !record(answers) ||
    !Object.values(answers).every((answer) => typeof answer === "string")
  ) {
    fail("toolAnswers maps a tool's name to the text it answers");
  }
  return {
    steps: decoded,
    state,
    toolAnswers: answers as Record<string, string>,
  };
}

/**
 * The theme a tried page is handed: the app's dark tokens, by the same names
 * the app sends, so a page that ignores them is caught looking wrong.
 */
export const PLUGIN_PAGE_TRY_THEME_TOKENS_V1: Record<string, string> = {
  surface: "#16171d",
  "surface-raised": "#23242c",
  text: "#eceef3",
  "text-muted": "#9da1ad",
  border: "#34353f",
  "border-strong": "#4a4c58",
  accent: "#db4b6d",
  "accent-surface": "#3a1c26",
  "on-accent": "#ffffff",
  danger: "#ef6a5f",
  "radius-control": "10px",
  "radius-card": "14px",
  "font-sans": "Inter, ui-sans-serif, system-ui, sans-serif",
  "font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
  "text-sm": "13px",
  "text-base": "14px",
  "text-lg": "17px",
  "motion-fast": "120ms",
};

/**
 * What the page may reach when tried: nothing, as in the app. The frame's
 * `sandbox` gives it an opaque origin; this gives it no network.
 */
const TRY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/**
 * The stand-in host, run in the top window around the page. It answers the
 * page exactly as the app's `PluginPageFrame` does: it greets each document
 * once it has loaded and answers `hello`; runs a tool call by answering with
 * the scripted text; opens the microphone only for a Plugin that declared it
 * and then streams 16 kHz PCM16 in 40 ms frames of whatever it is told to
 * hear; tells the page when either side closes it; and keeps every report.
 */
export const PLUGIN_PAGE_STAND_IN_HOST_JS_V1 = `(() => {
  const V = ${PLUGIN_PAGE_BRIDGE_VERSION_V1};
  const RATE = 16000;
  const FRAME = 640;
  const said = [];
  const reports = [];
  let frame = null;
  let config = null;
  let tone = null;
  let phase = 0;
  let streaming = null;
  let open = false;
  let greeted = false;
  const post = (m) => frame && frame.contentWindow && frame.contentWindow.postMessage(Object.assign({ frockbotPage: V }, m), "*");
  const init = () => {
    greeted = true;
    post({ type: "init", pluginId: config.pluginId, botId: config.botId, surfaceId: config.surfaceId, themeTokens: config.themeTokens, state: config.state });
  };
  const closed = (reason) => ({ type: "device", ability: "microphone", status: "closed", reason });
  const pcm = () => {
    const bytes = new Uint8Array(FRAME * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < FRAME; i++) {
      let v = 0;
      if (tone) {
        v = tone.level * Math.sin((2 * Math.PI * tone.frequency * (phase + i)) / RATE);
        if (tone.noise) v += tone.noise * (Math.random() * 2 - 1);
      }
      view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
    }
    phase += FRAME;
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text);
  };
  const stop = (reason) => {
    if (open) {
      open = false;
      clearInterval(streaming);
      streaming = null;
    }
    post(closed(reason));
  };
  addEventListener("message", (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || typeof m !== "object" || m.frockbotPage !== V) return;
    said.push(m.type === "report" ? "report:" + m.level : m.type);
    if (m.type === "hello") init();
    else if (m.type === "callTool") {
      const answer = Object.prototype.hasOwnProperty.call(config.toolAnswers, m.tool) ? config.toolAnswers[m.tool] : "ok";
      post({ type: "result", callId: m.callId, ok: true, output: String(answer) });
    } else if (m.type === "device" && m.ability === "microphone") {
      if (!m.open) stop("You stopped the microphone.");
      else if (!config.microphone) post(closed("This Plugin was not allowed the microphone."));
      else if (!open) {
        open = true;
        post({ type: "device", ability: "microphone", status: "open", sampleRate: RATE });
        streaming = setInterval(() => post({ type: "audio", pcm: pcm() }), 40);
      }
    } else if (m.type === "report" && typeof m.text === "string") {
      reports.push({ level: m.level, text: m.text.slice(0, ${PLUGIN_PAGE_REPORT_TEXT_MAX_V1}) });
    }
  });
  window.frockbotStandIn = {
    start(c) {
      config = c;
      frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.title = c.surfaceId;
      frame.addEventListener("load", init);
      frame.srcdoc = c.html;
      document.body.appendChild(frame);
    },
    tone(t) { tone = t; },
    silence() { tone = null; },
    hostStop() { if (open) stop("You stopped the microphone."); },
    state(s) { config.state = s; post({ type: "state", state: s }); },
    listening: () => open,
    greeted: () => greeted,
    reports: () => reports,
    said: () => said,
  };
})();`;

/** The page as the stand-in frames it: this try's policy first in `<head>`. */
export function pluginPageForTryV1(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${TRY_POLICY}">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + policy + html.slice(at);
  }
  return policy + html;
}

/**
 * The runner, as Node runs it on the Computer: `node run.mjs <dir>`, reading
 * `<dir>/request.json` and writing one JSON line of what happened. It starts
 * its own headless Chromium, never the person's shared browser, and resolves
 * `playwright-core` from the Computer's runtime install. `PAGE_TRY_PLAYWRIGHT`
 * and `PAGE_TRY_CHROMIUM` point it elsewhere, for the platform's own tests.
 */
export const PLUGIN_PAGE_TRY_RUNNER_MJS_V1 = `import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = process.argv[2];
const request = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
const require = createRequire(path.join(os.homedir(), ".frockbot", "node_modules", "runner.cjs"));
const { chromium } = require(process.env.PAGE_TRY_PLAYWRIGHT || "playwright-core");
const executablePath = process.env.PAGE_TRY_CHROMIUM || path.join(os.homedir(), "bin", "chromium");
// Well inside the command's own limit, so what happened always comes back.
const started = Date.now();
const left = () => ${PLUGIN_PAGE_TRY_DEADLINE_MS_V1} - (Date.now() - started);
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the page did not answer in time")), Math.max(0, ms)).unref()),
  ]);
const line = (error) => String(error).split("\\n")[0].slice(0, ${PLUGIN_PAGE_TRY_ERROR_MAX_V1});
const result = { text: "", greeted: false, reports: [], said: [], errors: [], steps: [], shots: [] };
let written = false;
const finish = () => {
  if (written) return;
  written = true;
  let out = JSON.stringify(result);
  // One line, small enough to come back through one command's output.
  while (Buffer.byteLength(out) > ${PLUGIN_PAGE_TRY_RESULT_MAX_BYTES_V1}) {
    if (result.text.length > 200) result.text = result.text.slice(0, result.text.length >> 1);
    else if (result.reports.length > 0) result.reports.shift();
    else if (result.said.length > 0) result.said.shift();
    else if (result.errors.length > 0) result.errors.pop();
    else if (result.steps.some((step) => step.error && step.error.length > 60)) {
      for (const step of result.steps) if (step.error) step.error = step.error.slice(0, 60);
    } else break;
    out = JSON.stringify(result);
  }
  process.stdout.write(out + "\\n");
};
setTimeout(() => {
  result.errors.unshift("the try was cut short before it finished");
  for (const step of request.steps.slice(result.steps.length)) {
    result.steps.push({ step: Object.keys(step)[0], ok: false, error: "not run: the try ran out of time" });
  }
  finish();
  process.exit(0);
}, ${PLUGIN_PAGE_TRY_DEADLINE_MS_V1} + 15000).unref();
const browser = await chromium.launch({
  executablePath,
  headless: true,
  timeout: 30000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
try {
  const page = await browser.newPage({ viewport: { width: request.width, height: request.height } });
  page.on("pageerror", (error) => {
    if (result.errors.length < 10) result.errors.push(line(String((error && error.stack) || error).split("\\n").slice(0, 3).join(" ")));
  });
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0;height:100%;background:" +
      request.config.themeTokens.surface +
      "}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>" +
      request.standIn +
      "</script></body></html>",
  );
  await within(page.evaluate((config) => window.frockbotStandIn.start(config), request.config), 10000);
  await page.waitForFunction(() => window.frockbotStandIn.greeted(), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(150);
  const frame = page.frameLocator("iframe");
  for (const step of request.steps) {
    const kind = Object.keys(step)[0];
    if (left() <= 0) {
      result.steps.push({ step: kind, ok: false, error: "not run: the try ran out of time" });
      continue;
    }
    try {
      await within((async () => {
        if (kind === "click") await frame.locator(step.click).first().click({ timeout: Math.min(5000, left()) });
        else if (kind === "tone") await page.evaluate((t) => window.frockbotStandIn.tone(t), step.tone);
        else if (kind === "silence") await page.evaluate(() => window.frockbotStandIn.silence());
        else if (kind === "hostStop") await page.evaluate(() => window.frockbotStandIn.hostStop());
        else if (kind === "state") await page.evaluate((s) => window.frockbotStandIn.state(s), step.state);
        else if (kind === "wait") await page.waitForTimeout(step.wait);
        else if (kind === "screenshot") {
          await page.waitForTimeout(100);
          // Small enough to come back through one command's output.
          let bytes;
          for (const quality of [70, 55, 40, 25]) {
            bytes = await page.screenshot({ type: "jpeg", quality, timeout: 10000 });
            if (bytes.length <= ${PLUGIN_PAGE_TRY_SHOT_MAX_BYTES_V1}) break;
          }
          if (bytes.length > ${PLUGIN_PAGE_TRY_SHOT_MAX_BYTES_V1}) {
            throw new Error("the picture was too busy to send back, so it was left out");
          }
          const file = path.join(dir, "shot-" + result.shots.length + ".jpg");
          fs.writeFileSync(file, bytes);
          result.shots.push({ label: step.screenshot, file });
        }
      })(), left());
      const listening = await within(page.evaluate(() => window.frockbotStandIn.listening()), 5000);
      result.steps.push({ step: kind, ok: true, listening });
    } catch (error) {
      result.steps.push({ step: kind, ok: false, error: line((error && error.message) || error) });
    }
  }
  result.text = (await frame.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 3000);
  const host = await within(
    page.evaluate(() => ({
      greeted: window.frockbotStandIn.greeted(),
      reports: window.frockbotStandIn.reports(),
      said: window.frockbotStandIn.said(),
    })),
    5000,
  ).catch(() => null);
  if (host) {
    result.greeted = host.greeted;
    result.reports = host.reports.slice(-20);
    result.said = host.said.slice(-60);
  }
} finally {
  finish();
  await within(browser.close(), 10000).catch(() => {});
}
`;

/** What the runner hands back. */
export interface PluginPageTryResultV1 {
  text: string;
  greeted: boolean;
  reports: { level: string; text: string }[];
  said: string[];
  errors: string[];
  steps: { step: string; ok: boolean; listening?: boolean; error?: string }[];
  /** Each picture, left in the try's directory for the tool to fetch. */
  shots: { label: string; file: string }[];
}
