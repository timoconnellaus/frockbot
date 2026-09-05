import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { nativeFallbackResponse } from "./native-fallback.js";

const epoch = "navigation_epoch_1234";
const hash = "a".repeat(64);
const url = `https://ui.bot.frockbot.com/native-fallback?artifact=${hash}&epoch=${epoch}`;

describe("anonymous native Applet bootstrap", () => {
  test("isolates the approved artifact and carries no session, token or native bridge", async () => {
    const response = nativeFallbackResponse(new Request(url));
    const html = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      `frame-src https://ui.bot.frockbot.com/packages/${hash}.html`,
    );
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("javascriptChannel");
    expect(html).not.toContain("Bearer");
    expect(html).not.toContain("?token=");
    // The whole kit palette travels, not just three names; anything missing
    // falls back to the kit's light defaults and looks off-brand on the phone.
    for (const name of [
      "surface-raised",
      "surface-subtle",
      "text-muted",
      "border",
      "accent-surface",
      "accent-text",
      "radius-card",
    ]) {
      expect(html).toContain(`"${name}":`);
    }
    expect(html).toContain("background:#1b1a20");
  });
  test("refuses attacker origins, artifact paths, duplicate queries and non-GET", () => {
    for (const input of [
      url.replace("ui.bot.frockbot.com", "evil.test"),
      url.replace(hash, "../../account"),
      `${url}&epoch=again`,
      `${url}&token=secret`,
    ]) {
      expect(nativeFallbackResponse(new Request(input)).status).toBe(400);
    }
    expect(
      nativeFallbackResponse(new Request(url, { method: "POST" })).status,
    ).toBe(400);
  });
  test("only the exact child can complete handshake; epoch, reload and disposal fence callbacks", async () => {
    const html = await nativeFallbackResponse(new Request(url)).text();
    const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]!;
    const sent: unknown[] = [];
    let onMessage: (event: unknown) => void = () => {};
    let onLoad: () => void = () => {};
    const child = { postMessage: (message: unknown) => sent.push(message) };
    const frame = {
      contentWindow: child,
      addEventListener: (_: string, callback: () => void) => {
        onLoad = callback;
      },
      remove() {},
      src: "",
    };
    const window: {
      addEventListener: (name: string, handler: typeof onMessage) => void;
      frockbotFallback?: {
        ready(): string | null;
        provide(epoch: string, value: unknown): boolean;
        close(): void;
      };
    } = {
      addEventListener: (_, callback) => {
        onMessage = callback;
      },
    };
    runInNewContext(script, {
      window,
      document: { getElementById: () => frame },
    });
    const host = window.frockbotFallback!;
    const ready = {
      schemaVersion: 1,
      type: "applet/ready",
      tokenTransport: "subprotocol-v1",
    };
    onMessage({ source: {}, origin: "null", data: ready });
    expect(host.ready()).toBeNull();
    onMessage({
      source: child,
      origin: "null",
      data: { ...ready, malicious: true },
    });
    expect(host.ready()).toBeNull();
    onMessage({ source: child, origin: "null", data: ready });
    expect(host.ready()).toBe(epoch);
    expect(
      host.provide("old-epoch", { tokenTransport: "subprotocol-v1" }),
    ).toBe(false);
    expect(
      host.provide(epoch, {
        tokenTransport: "subprotocol-v1",
        token: "synthetic-scoped-viewer",
      }),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    onLoad();
    onLoad();
    expect(host.provide(epoch, { tokenTransport: "subprotocol-v1" })).toBe(
      false,
    );
    host.close();
    onMessage({ source: child, data: ready });
    expect(host.ready()).toBeNull();
  });
});
