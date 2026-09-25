// Learning from a demonstration (parity row 54), as this Computer records it.
//
// Two programs. The page script runs in every frame of every tab in the Bot's
// own browser window while the person holds control, and reports what they
// did — a click, typing into a field, a special key, a choice, a tab coming to
// the front — to a binding the recorder exposes. The recorder is a Node
// program on the Computer that attaches to the one browser over CDP, numbers
// the tabs, records navigations, photographs the page at a few steps with every
// form field covered, and stops by itself when the person's lease goes.
//
// What neither of them may do is the whole design. The page script never
// reads a field's value, its text or its selection: a field is described by
// its role, its label and a selector, and only by attributes the page's author
// wrote. A password field — and anything that asks for a one-time code or a
// card number — reports nothing at all, not even that it was typed into. A key
// is reported only when it is a special key or a shortcut held with Control or
// Meta, never a printable character. The step decoder in
// `@frockbot/computer/core/host` holds the recorder to the same rules again on
// the way out.
//
// The recorder is generated from constants rather than importing the runtime
// module, which lists it among the files it installs: the two would otherwise
// import each other.

/** Prefixes the one line of `collect` that is the capture. */
export const DEMONSTRATION_MARKER = "__FROCKBOT_DEMONSTRATION__";
/** Printed by `stop` when this Bot has no capture on the Computer. */
export const DEMONSTRATION_NONE_MARKER = "__FROCKBOT_DEMONSTRATION_NONE__";
/** Printed by `start` once the recorder has attached to the browser. */
export const DEMONSTRATION_STARTED_MARKER =
  "__FROCKBOT_DEMONSTRATION_STARTED__";
/** Printed by `start` when the caller does not hold the desktop lease. */
export const DEMONSTRATION_NOT_HOLDER_MARKER =
  "__FROCKBOT_DEMONSTRATION_NOT_HOLDER__";
/** Printed by `start` on a Computer provisioned before recording existed. */
export const DEMONSTRATION_MISSING_MARKER =
  "__FROCKBOT_DEMONSTRATION_MISSING__";
/** Printed by `start` when the recorder did not attach, with its reason. */
export const DEMONSTRATION_FAILED_MARKER = "__FROCKBOT_DEMONSTRATION_FAILED__";

/** Screenshot candidates kept on the Computer before they are thinned. */
export const DEMONSTRATION_SCREENSHOT_CANDIDATES = 12;

/**
 * What a screenshot covers: every control a person types into or picks from,
 * and every frame, because a card number is usually typed into someone
 * else's iframe. Buttons, checkboxes and radios stay visible — what they say
 * is the page's, not the person's.
 */
export const DEMONSTRATION_MASK_SELECTOR = [
  "input:not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio])",
  "textarea",
  "select",
  "iframe",
  "[contenteditable]:not([contenteditable=false])",
].join(", ");

/**
 * The page script, as a function source. It takes the binding's name, which
 * is new per recording: listeners a finished recording left in a page call a
 * binding nobody answers, and never the next recording's.
 *
 * Plain ES2017 with no template literals, because it is embedded in the
 * recorder's source and evaluated as-is in pages this product did not write.
 */
export const DEMONSTRATION_PAGE_SOURCE = String.raw`function (bindingName) {
  var installed = "__frockbotDemonstration:" + bindingName;
  if (window[installed]) return;
  window[installed] = true;

  var BUTTON_TYPES = { submit: 1, button: 1, reset: 1, image: 1 };
  var NOT_TYPED = { checkbox: 1, radio: 1, file: 1, hidden: 1, range: 1, color: 1 };
  var SPECIAL_KEYS = {
    Enter: 1, Tab: 1, Escape: 1, Backspace: 1, Delete: 1, ArrowUp: 1,
    ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, PageUp: 1, PageDown: 1,
    Home: 1, End: 1, F1: 1, F2: 1, F3: 1, F4: 1, F5: 1, F6: 1, F7: 1,
    F8: 1, F9: 1, F10: 1, F11: 1, F12: 1
  };
  var SECRET_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|$)/i;
  var SECRET_WORDS = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd|otp|cvc|cvv|csc|ssn|pin)([^a-z]|$)|card.?(number|num|no)|security.?code|one.?time/i;
  var typing = null;

  function send(payload) {
    var binding = window[bindingName];
    if (typeof binding !== "function") return;
    try {
      var answer = binding(payload);
      if (answer && typeof answer.then === "function") answer.then(null, function () {});
    } catch (error) {}
  }
  function attr(element, name) {
    if (!element || typeof element.getAttribute !== "function") return "";
    var value = element.getAttribute(name);
    return typeof value === "string" ? value : "";
  }
  function tagOf(element) {
    return element && typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  }
  function inputType(element) {
    return attr(element, "type").toLowerCase() || "text";
  }
  function squash(text, limit) {
    var clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > limit ? clean.slice(0, limit) : clean;
  }
  function elementOf(node) {
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node || null;
  }

  // The control a person types into, or null. A contenteditable region is
  // named by its editing host, never by the paragraph inside it that holds
  // what they wrote.
  function fieldOf(element) {
    var tag = tagOf(element);
    if (tag === "input") {
      var type = inputType(element);
      return BUTTON_TYPES[type] || NOT_TYPED[type] ? null : element;
    }
    if (tag === "textarea" || tag === "select") return element;
    if (element && element.isContentEditable === true) {
      var host = element;
      while (host.parentElement && host.parentElement.isContentEditable === true) host = host.parentElement;
      return host;
    }
    return null;
  }

  // A field whose contents are a secret leaves no trace at all.
  function secret(element) {
    if (tagOf(element) === "input" && inputType(element) === "password") return true;
    if (SECRET_AUTOCOMPLETE.test(attr(element, "autocomplete"))) return true;
    return SECRET_WORDS.test(
      [attr(element, "name"), attr(element, "id"), attr(element, "aria-label"), attr(element, "placeholder")].join(" ")
    );
  }

  // The text a person reads in an element, skipping anything they could have
  // typed into: a label that wraps its own input says the label, not the input.
  function readable(node, depth) {
    if (!node || depth > 8) return "";
    if (node.nodeType === 3) return node.data || "";
    if (node.nodeType !== 1) return "";
    var tag = tagOf(node);
    if (tag === "script" || tag === "style" || tag === "option") return "";
    if (fieldOf(node)) return "";
    var parts = [];
    var children = node.childNodes || [];
    for (var index = 0; index < children.length && index < 50; index += 1) {
      parts.push(readable(children[index], depth + 1));
    }
    return parts.join(" ");
  }
  function labelled(element) {
    var ids = attr(element, "aria-labelledby").split(/\s+/);
    var parts = [];
    for (var index = 0; index < ids.length; index += 1) {
      if (!ids[index] || typeof document.getElementById !== "function") continue;
      var label = document.getElementById(ids[index]);
      if (label) parts.push(readable(label, 0));
    }
    return squash(parts.join(" "), 120);
  }
  function labelText(element) {
    var labels = element.labels || [];
    var parts = [];
    for (var index = 0; index < labels.length; index += 1) parts.push(readable(labels[index], 0));
    return squash(parts.join(" "), 120);
  }
  function nameOf(element, field) {
    var name = squash(attr(element, "aria-label"), 120) || labelled(element);
    if (name) return name;
    var tag = tagOf(element);
    if (field) {
      return labelText(element) || squash(attr(element, "placeholder"), 120) ||
        squash(attr(element, "title"), 120) || squash(attr(element, "name"), 120);
    }
    if (tag === "input") {
      // A button's caption is the attribute its author wrote, never a
      // property the person could have changed.
      return labelText(element) ||
        (BUTTON_TYPES[inputType(element)] ? squash(attr(element, "value") || attr(element, "alt"), 120) : "") ||
        squash(attr(element, "title"), 120);
    }
    if (tag === "img") return squash(attr(element, "alt"), 120);
    return squash(readable(element, 0), 120) || squash(attr(element, "title"), 120);
  }

  function roleOf(element, field) {
    var explicit = attr(element, "role").toLowerCase().split(/\s+/)[0];
    if (/^[a-z][a-z-]{0,39}$/.test(explicit)) return explicit;
    var tag = tagOf(element);
    if (field && tag !== "input" && tag !== "textarea" && tag !== "select") return "textbox";
    if (tag === "a") return attr(element, "href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return element.hasAttribute && element.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "option") return "option";
    if (tag === "li") return "listitem";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      var type = inputType(element);
      if (BUTTON_TYPES[type]) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    return "generic";
  }

  function quote(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function stableId(value) {
    return value && value.length <= 64 && /^[A-Za-z][\w-]*$/.test(value) && !/\d{4,}/.test(value);
  }
  function selectorOf(element) {
    var tag = tagOf(element) || "*";
    var id = attr(element, "id");
    if (stableId(id)) return "#" + id;
    var hooks = ["data-testid", "data-test", "data-qa"];
    for (var index = 0; index < hooks.length; index += 1) {
      var hook = attr(element, hooks[index]);
      if (hook && hook.length <= 80) return tag + "[" + hooks[index] + '="' + quote(hook) + '"]';
    }
    var name = attr(element, "name");
    if (name && name.length <= 80 && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) {
      return tag + '[name="' + quote(name) + '"]';
    }
    var label = attr(element, "aria-label");
    if (label && label.length <= 60) return tag + '[aria-label="' + quote(label) + '"]';
    var href = attr(element, "href");
    if (tag === "a" && href && href.length <= 80 && href.indexOf("?") < 0 && href.indexOf("#") < 0) {
      return 'a[href="' + quote(href) + '"]';
    }
    var path = [];
    var node = element;
    while (node && node.nodeType === 1 && path.length < 4) {
      var nodeTag = tagOf(node);
      var nodeId = attr(node, "id");
      if (node !== element && stableId(nodeId)) {
        path.unshift("#" + nodeId);
        break;
      }
      var position = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (tagOf(sibling) === nodeTag) position += 1;
        sibling = sibling.previousElementSibling;
      }
      path.unshift(nodeTag + ":nth-of-type(" + position + ")");
      if (nodeTag === "body") break;
      node = node.parentElement;
    }
    return path.join(" > ").slice(0, 300);
  }

  var INTERACTIVE = { a: 1, button: 1, input: 1, select: 1, textarea: 1, summary: 1, label: 1, option: 1 };
  // The element a click meant: the nearest link, button or control above
  // what was hit, and a label's control rather than the label.
  function clicked(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    var element = elementOf(path.length ? path[0] : event.target);
    var hit = element;
    for (var node = element, depth = 0; node && node.nodeType === 1 && depth < 8; node = node.parentElement, depth += 1) {
      if (INTERACTIVE[tagOf(node)] || attr(node, "role") || fieldOf(node)) {
        hit = node;
        break;
      }
    }
    if (tagOf(hit) === "label" && hit.control) hit = hit.control;
    return hit;
  }
  function described(element) {
    var field = fieldOf(element);
    var target = field || element;
    var name = nameOf(target, Boolean(field));
    var payload = { role: roleOf(target, Boolean(field)), selector: selectorOf(target) };
    if (name) payload.name = name;
    return payload;
  }
  function withKind(kind, payload) {
    payload.kind = kind;
    return payload;
  }

  document.addEventListener("click", function (event) {
    var element = clicked(event);
    if (!element) return;
    var field = fieldOf(element);
    if (field && secret(field)) return;
    typing = null;
    send(withKind("click", described(element)));
  }, true);

  document.addEventListener("input", function (event) {
    var field = fieldOf(elementOf(event.target));
    if (!field || tagOf(field) === "select" || secret(field)) return;
    // One step per field until the person moves on: what they typed is never
    // read, so a keystroke would only say the same thing again.
    if (typing === field) return;
    typing = field;
    send(withKind("type", described(field)));
  }, true);

  document.addEventListener("change", function (event) {
    var element = elementOf(event.target);
    if (tagOf(element) !== "select" || secret(element)) return;
    typing = null;
    send(withKind("choose", described(element)));
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.repeat || event.isComposing) return;
    var field = fieldOf(elementOf(event.target));
    if (field && secret(field)) return;
    var key = typeof event.key === "string" ? event.key : "";
    var modifiers = [];
    if (event.ctrlKey) modifiers.push("Control");
    if (event.metaKey) modifiers.push("Meta");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (SPECIAL_KEYS[key]) {
      if (key === "Enter" || key === "Tab") typing = null;
      send({ kind: "key", key: modifiers.concat([key]).join("+") });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.length === 1 && /^[a-z0-9]$/i.test(key)) {
      send({ kind: "key", key: modifiers.concat([key.toLowerCase()]).join("+") });
    }
  }, true);

  document.addEventListener("focusin", function (event) {
    if (fieldOf(elementOf(event.target)) !== typing) typing = null;
  }, true);

  if (window.top === window) {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") send({ kind: "visible" });
    }, true);
  }
}`;

/** The page script for one recording's binding, ready to evaluate. */
export function demonstrationPageScriptV1(bindingName: string): string {
  return `(${DEMONSTRATION_PAGE_SOURCE})(${JSON.stringify(bindingName)});`;
}

export interface DemonstrationRecorderConfigV1 {
  /** Where each Bot's runtime directory is. */
  botsRoot: string;
  /** The file in a Bot's directory naming its browser window's target. */
  targetIdFile: string;
  /** The User-wide lease file a human session holds. */
  leasePath: string;
  leaseMaxAgeSeconds: number;
  maxSteps: number;
  maxScreenshots: number;
  maxScreenshotBytes: number;
}

/**
 * The recorder: `record <port> <botKey> <dir> <ownerId> <deadlineMs>` while
 * the person holds control, and `collect <dir>` to hand back what was
 * recorded. `collect` reads only what `record` wrote, so a recorder that
 * crashed still hands back every step it had written down.
 */
export function demonstrationRecorderV1(
  config: DemonstrationRecorderConfigV1,
): string {
  const constants = JSON.stringify({
    ...config,
    marker: DEMONSTRATION_MARKER,
    candidates: DEMONSTRATION_SCREENSHOT_CANDIDATES,
    mask: DEMONSTRATION_MASK_SELECTOR,
  });
  return `import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

const CONFIG = ${constants};
const PAGE_SOURCE = ${JSON.stringify(DEMONSTRATION_PAGE_SOURCE)};
const [mode, ...rest] = process.argv.slice(2);

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The screenshots on disk, oldest first. */
function shots(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const match = /^shot-(\\d+)-(\\d+)\\.jpg$/.exec(name);
    if (match) found.push({ name, seq: Number(match[1]), afterStep: Number(match[2]) });
  }
  return found.sort((left, right) => left.seq - right.seq);
}

/** At most \`count\` of them, spread from the first to the last. */
function spread(list, count) {
  if (list.length <= count) return list;
  const chosen = new Set();
  for (let index = 0; index < count; index += 1) {
    chosen.add(list[Math.round((index * (list.length - 1)) / (count - 1))]);
  }
  return [...chosen];
}

if (mode === "collect") {
  const dir = rest[0];
  const steps = readText(\`\${dir}/events.jsonl\`)
    .split("\\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let stopped = {};
  try {
    stopped = JSON.parse(readText(\`\${dir}/stopped\`));
  } catch {}
  const screenshots = spread(shots(dir), CONFIG.maxScreenshots).flatMap((shot) => {
    try {
      const bytes = readFileSync(\`\${dir}/\${shot.name}\`);
      return bytes.length <= CONFIG.maxScreenshotBytes
        ? [{ afterStep: shot.afterStep, bytesBase64: bytes.toString("base64") }]
        : [];
    } catch {
      return [];
    }
  });
  console.log(
    CONFIG.marker +
      JSON.stringify({
        startedAt: readText(\`\${dir}/started\`).trim() || new Date().toISOString(),
        stoppedAt: typeof stopped.stoppedAt === "string" ? stopped.stoppedAt : new Date().toISOString(),
        stoppedBecause: typeof stopped.reason === "string" ? stopped.reason : "stopped",
        steps,
        screenshots,
      }),
  );
  process.exit(0);
}

const { chromium } = await import("playwright-core");
const [port, botKey, dir, ownerId, deadlineArgument] = rest;
const deadline = Number(deadlineArgument);
const started = Date.now();
writeFileSync(\`\${dir}/started\`, new Date(started).toISOString());

let browser;
let finished = false;
let stepCount = 0;
let lastTab = 0;
let shotSequence = 0;
let lastShotAt = 0;
let shotTimer;
const lastUrl = new Map();
const tabs = new Map();
const binding = \`__frockbotDemonstrate_\${randomBytes(6).toString("hex")}\`;
const pageScript = \`(\${PAGE_SOURCE})(\${JSON.stringify(binding)});\`;

const seconds = () => Math.round((Date.now() - started) / 100) / 10;

function record(step) {
  if (finished) return;
  stepCount += 1;
  appendFileSync(\`\${dir}/events.jsonl\`, \`\${JSON.stringify(step)}\\n\`, { mode: 0o600 });
  if (stepCount >= CONFIG.maxSteps) void finish("step-limit");
}

/** Keeps the candidates spread across the whole demonstration. */
function thin() {
  const kept = shots(dir);
  if (kept.length <= CONFIG.candidates) return;
  kept.forEach((shot, index) => {
    if (index % 2 === 1 && index !== kept.length - 1) {
      try {
        unlinkSync(\`\${dir}/\${shot.name}\`);
      } catch {}
    }
  });
}

async function shoot(page) {
  if (finished || Date.now() - lastShotAt < 2500) return;
  lastShotAt = Date.now();
  try {
    // Only the tab the person is looking at: a background tab is not what
    // they did, and capturing one must never bring it to the front.
    if ((await page.evaluate(() => document.visibilityState)) !== "visible") return;
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 55,
      scale: "css",
      animations: "disabled",
      caret: "hide",
      mask: [page.locator(CONFIG.mask)],
      maskColor: "#8b93a1",
      timeout: 5000,
    });
    if (finished || bytes.length > CONFIG.maxScreenshotBytes) return;
    shotSequence += 1;
    writeFileSync(\`\${dir}/shot-\${shotSequence}-\${stepCount}.jpg\`, bytes, { mode: 0o600 });
    thin();
  } catch {}
}

function scheduleShot(page, delay) {
  clearTimeout(shotTimer);
  shotTimer = setTimeout(() => void shoot(page), delay);
}

async function finish(reason) {
  if (finished) return;
  finished = true;
  clearTimeout(shotTimer);
  writeFileSync(\`\${dir}/stopped\`, JSON.stringify({ reason, stoppedAt: new Date().toISOString() }));
  await browser?.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void finish("stopped"));
process.on("SIGINT", () => void finish("stopped"));

/** A step is rebuilt field by field: nothing a page sent is spread into one. */
function onPage(page, payload) {
  const tab = tabs.get(page);
  if (!tab || !payload || typeof payload !== "object") return;
  const t = seconds();
  if (payload.kind === "visible") {
    if (lastTab !== 0 && tab !== lastTab) record({ action: "switch-tab", t, tab, url: page.url() });
    lastTab = tab;
    return;
  }
  if (payload.kind === "click" || payload.kind === "type" || payload.kind === "choose") {
    const step = {
      action: payload.kind,
      t,
      tab,
      role: String(payload.role ?? ""),
      selector: String(payload.selector ?? ""),
    };
    if (typeof payload.name === "string" && payload.name) step.name = payload.name;
    record(step);
    lastTab = tab;
    if (payload.kind === "click") scheduleShot(page, 900);
    return;
  }
  if (payload.kind === "key" && typeof payload.key === "string") {
    record({ action: "key", t, tab, key: payload.key });
    lastTab = tab;
    if (payload.key === "Enter") scheduleShot(page, 1200);
  }
}

async function attach(page, visible) {
  if (finished || tabs.has(page)) return;
  const tab = tabs.size + 1;
  tabs.set(page, tab);
  lastUrl.set(tab, page.url());
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (lastUrl.get(tab) === url) return;
    lastUrl.set(tab, url);
    record({ action: "navigate", t: seconds(), tab, url });
    lastTab = tab;
  });
  page.on("load", () => scheduleShot(page, 600));
  page.on("popup", (popup) => void attach(popup, true));
  try {
    await page.exposeBinding(binding, (_source, payload) => onPage(page, payload));
    await page.addInitScript(pageScript);
    for (const frame of page.frames()) await frame.evaluate(pageScript).catch(() => {});
  } catch {}
  if (visible) {
    const url = page.url();
    if (url && url !== "about:blank") record({ action: "navigate", t: seconds(), tab, url });
    lastTab = tab;
    scheduleShot(page, 0);
  }
}

browser = await chromium.connectOverCDP(\`http://127.0.0.1:\${port}\`);
browser.on("disconnected", () => void finish("stopped"));
const cdp = await browser.newBrowserCDPSession();

async function windowOf(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    return windowId;
  } finally {
    await session.detach().catch(() => {});
  }
}

const anchor = readText(\`\${CONFIG.botsRoot}/\${botKey}/\${CONFIG.targetIdFile}\`).trim();
if (!anchor) {
  console.error("this Bot has no browser window to record");
  process.exit(70);
}
const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: anchor });
for (const context of browser.contexts()) {
  context.on("page", async (page) => {
    if ((await windowOf(page).catch(() => undefined)) === windowId) await attach(page, true);
  });
  for (const page of context.pages()) {
    if ((await windowOf(page).catch(() => undefined)) !== windowId) continue;
    const state = await page.evaluate(() => document.visibilityState).catch(() => "hidden");
    await attach(page, state === "visible");
  }
}

function leaseHeld() {
  try {
    if (readFileSync(CONFIG.leasePath, "utf8").split("\\n")[0] !== ownerId) return false;
    return (Date.now() - statSync(CONFIG.leasePath).mtimeMs) / 1000 <= CONFIG.leaseMaxAgeSeconds;
  } catch {
    return false;
  }
}

setInterval(() => {
  if (Date.now() >= deadline) void finish("time-limit");
  else if (!leaseHeld()) void finish("control-released");
}, 2000);
writeFileSync(\`\${dir}/ready\`, "1");
`;
}
