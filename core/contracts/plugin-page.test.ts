import { describe, expect, test } from "bun:test";
import {
  decodePluginPageMessageV1,
  MAX_PLUGIN_PAGE_STATE_BYTES_V1,
  PLUGIN_PAGE_HELPER_JS_V1,
  pluginPageStateV1,
  withPluginPageBridgeV1,
} from "./plugin-page.js";

const SCRIPT = `<script>${PLUGIN_PAGE_HELPER_JS_V1}</script>`;

describe("the bridge a stored page carries", () => {
  test("goes first in <head>, before any of the page's own script", () => {
    const page =
      '<!doctype html><html lang="en"><head><title>Tuner</title><script>go()</script></head></html>';
    const stored = withPluginPageBridgeV1(page);
    expect(stored).toBe(
      `<!doctype html><html lang="en"><head>${SCRIPT}<title>Tuner</title><script>go()</script></head></html>`,
    );
  });

  test("follows <html> when there is no head, and leads a fragment", () => {
    expect(withPluginPageBridgeV1("<html><body>x</body></html>")).toBe(
      `<html>${SCRIPT}<body>x</body></html>`,
    );
    expect(withPluginPageBridgeV1("<p>x</p>")).toBe(`${SCRIPT}<p>x</p>`);
  });

  test("does not mistake <header> for <head>", () => {
    expect(withPluginPageBridgeV1("<header>x</header>")).toBe(
      `${SCRIPT}<header>x</header>`,
    );
  });

  test("cannot close its own script element early", () => {
    expect(PLUGIN_PAGE_HELPER_JS_V1).not.toContain("</script");
  });
});

describe("what a page may say", () => {
  test("hello, and a call to one of its Plugin's tools", () => {
    expect(
      decodePluginPageMessageV1({ frockbotPage: 1, type: "hello" }),
    ).toEqual({ frockbotPage: 1, type: "hello" });
    expect(
      decodePluginPageMessageV1({
        frockbotPage: 1,
        type: "callTool",
        callId: "c1",
        tool: "record_move",
        input: { from: "e2", to: "e4" },
      }),
    ).toEqual({
      frockbotPage: 1,
      type: "callTool",
      callId: "c1",
      tool: "record_move",
      input: { from: "e2", to: "e4" },
    });
  });

  test("nothing else, and nothing with an extra key", () => {
    for (const message of [
      null,
      "hello",
      { type: "hello" },
      { frockbotPage: 2, type: "hello" },
      { frockbotPage: 1, type: "hello", extra: true },
      { frockbotPage: 1, type: "init" },
      {
        frockbotPage: 1,
        type: "callTool",
        callId: "c1",
        tool: "Bad-Name",
        input: {},
      },
      { frockbotPage: 1, type: "callTool", callId: "", tool: "go", input: {} },
      {
        frockbotPage: 1,
        type: "callTool",
        callId: "c1",
        tool: "go",
        input: [],
      },
      { frockbotPage: 1, type: "callTool", callId: "c1", tool: "go" },
    ]) {
      expect(decodePluginPageMessageV1(message)).toBeUndefined();
    }
  });
});

describe("a page view's state", () => {
  test("is a JSON object within the budget", () => {
    expect(pluginPageStateV1({ moves: ["e4"] })).toEqual({
      state: { moves: ["e4"] },
    });
    expect(pluginPageStateV1([1])).toEqual({
      failure: "the page's view must return an object",
    });
    expect(
      pluginPageStateV1({ big: "x".repeat(MAX_PLUGIN_PAGE_STATE_BYTES_V1) }),
    ).toHaveProperty("failure");
  });
});

/** A window just rich enough to run the helper, with the page as its own parent. */
function pageWindow() {
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const posted: Record<string, unknown>[] = [];
  const properties = new Map<string, string>();
  const timers: (() => void)[] = [];
  const win: Record<string, unknown> = {};
  const parent = {
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
    },
  };
  Object.assign(win, {
    parent,
    addEventListener(
      _type: string,
      listener: (event: { source: unknown; data: unknown }) => void,
    ) {
      listeners.push(listener);
    },
    document: {
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            properties.set(name, value);
          },
        },
      },
    },
    setTimeout(fn: () => void) {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
  });
  new Function(
    "window",
    "parent",
    "addEventListener",
    "document",
    "setTimeout",
    "clearTimeout",
    PLUGIN_PAGE_HELPER_JS_V1,
  )(
    win,
    parent,
    win.addEventListener,
    win.document,
    win.setTimeout,
    win.clearTimeout,
  );
  const frockbot = win.frockbot as {
    ready: Promise<Record<string, unknown>>;
    state: Record<string, unknown>;
    onState(fn: (state: Record<string, unknown>) => void): () => void;
    callTool(name: string, input?: Record<string, unknown>): Promise<string>;
    openMicrophone(
      onSamples: (samples: Float32Array) => void,
      onClosed?: (reason: string) => void,
    ): Promise<{ sampleRate: number; close(): void }>;
  };
  return {
    frockbot,
    posted,
    properties,
    deliver(data: unknown, source: unknown = parent) {
      for (const listener of listeners) listener({ source, data });
    },
  };
}

describe("the helper, as a page runs it", () => {
  const init = {
    frockbotPage: 1,
    type: "init",
    pluginId: "tuner",
    botId: "bot-1",
    surfaceId: "tuner",
    themeTokens: { accent: "#ff3366" },
    state: { a4: 440 },
  };

  test("says hello, then resolves ready and sets the theme on init", async () => {
    const page = pageWindow();
    expect(page.posted).toEqual([{ frockbotPage: 1, type: "hello" }]);
    page.deliver(init);
    expect(await page.frockbot.ready).toEqual({
      pluginId: "tuner",
      botId: "bot-1",
      surfaceId: "tuner",
      themeTokens: { accent: "#ff3366" },
      state: { a4: 440 },
    });
    expect(page.properties.get("--frockbot-accent")).toBe("#ff3366");
    expect(page.frockbot.state).toEqual({ a4: 440 });
  });

  test("hears new state and nothing from anyone but its parent", async () => {
    const page = pageWindow();
    page.deliver(init);
    const seen: unknown[] = [];
    page.frockbot.onState((state) => seen.push(state));
    page.deliver({ frockbotPage: 1, type: "state", state: { a4: 442 } }, {});
    page.deliver({ frockbotPage: 1, type: "state", state: { a4: 432 } });
    expect(seen).toEqual([{ a4: 432 }]);
    expect(page.frockbot.state).toEqual({ a4: 432 });
  });

  test("resolves a tool call with its text and rejects with the host's reason", async () => {
    const page = pageWindow();
    const moved = page.frockbot.callTool("record_move", { to: "e4" });
    const refused = page.frockbot.callTool("record_move", { to: "e9" });
    expect(page.posted.slice(1)).toEqual([
      {
        frockbotPage: 1,
        type: "callTool",
        callId: "c1",
        tool: "record_move",
        input: { to: "e4" },
      },
      {
        frockbotPage: 1,
        type: "callTool",
        callId: "c2",
        tool: "record_move",
        input: { to: "e9" },
      },
    ]);
    page.deliver({
      frockbotPage: 1,
      type: "result",
      callId: "c2",
      ok: false,
      error: "e9 is off the board",
    });
    page.deliver({
      frockbotPage: 1,
      type: "result",
      callId: "c1",
      ok: true,
      output: "moved",
    });
    expect(await moved).toBe("moved");
    await expect(refused).rejects.toThrow("e9 is off the board");
  });
});

describe("the microphone, as a page asks for it", () => {
  const OPEN = {
    frockbotPage: 1,
    type: "device",
    ability: "microphone",
    status: "open",
    sampleRate: 16000,
  };

  test("a page's device message is decoded exactly", () => {
    expect(
      decodePluginPageMessageV1({
        frockbotPage: 1,
        type: "device",
        ability: "microphone",
        open: true,
      }),
    ).toEqual({
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      open: true,
    });
    for (const message of [
      { frockbotPage: 1, type: "device", ability: "camera", open: true },
      { frockbotPage: 1, type: "device", ability: "microphone", open: "yes" },
      { frockbotPage: 1, type: "device", ability: "microphone" },
    ]) {
      expect(decodePluginPageMessageV1(message)).toBeUndefined();
    }
  });

  test("opens once the host says so, then hears each frame as samples", async () => {
    const page = pageWindow();
    const heard: number[][] = [];
    const opening = page.frockbot.openMicrophone((samples: Float32Array) =>
      heard.push([...samples]),
    );
    expect(page.posted.at(-1)).toEqual({
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      open: true,
    });
    // A frame before the host opened it is not the page's to hear.
    page.deliver({ frockbotPage: 1, type: "audio", pcm: "AAA=" });
    page.deliver(OPEN);
    expect((await opening).sampleRate).toBe(16000);
    // Little-endian 16-bit: 0, 16384 (0.5), -32768 (-1).
    const bytes = new Uint8Array([0, 0, 0, 0x40, 0, 0x80]);
    page.deliver({
      frockbotPage: 1,
      type: "audio",
      pcm: btoa(String.fromCharCode(...bytes)),
    });
    expect(heard).toEqual([[0, 0.5, -1]]);
  });

  test("hears the host close it, and refuses a second open meanwhile", async () => {
    const page = pageWindow();
    const closed: string[] = [];
    const opening = page.frockbot.openMicrophone(
      () => {},
      (reason: string) => closed.push(reason),
    );
    await expect(page.frockbot.openMicrophone(() => {})).rejects.toThrow(
      "already open",
    );
    page.deliver(OPEN);
    await opening;
    page.deliver({
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      status: "closed",
      reason: "You stopped the microphone.",
    });
    expect(closed).toEqual(["You stopped the microphone."]);
  });

  test("rejects with the host's reason when refused, and closes by asking", async () => {
    const page = pageWindow();
    const refused = page.frockbot.openMicrophone(() => {});
    page.deliver({
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      status: "closed",
      reason: "This Plugin was not allowed the microphone.",
    });
    await expect(refused).rejects.toThrow("not allowed the microphone");
    const opening = page.frockbot.openMicrophone(() => {});
    page.deliver(OPEN);
    (await opening).close();
    expect(page.posted.at(-1)).toEqual({
      frockbotPage: 1,
      type: "device",
      ability: "microphone",
      open: false,
    });
  });
});
