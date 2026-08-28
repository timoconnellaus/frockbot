import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import capacitorConfig from "../../capacitor.config.ts";

type Insets = { top: number; right: number; bottom: number; left: number };
type Rect = Insets & { width: number; height: number };
type Layout = {
  viewport: { width: number; height: number };
  auth: { root: Rect; probe: Rect };
  authenticated: {
    root: Rect;
    topbar: Rect;
    surface: Rect;
    hostedRoot: Rect;
    actions: Rect;
  };
};

const browserInsets: Insets = { top: 11, right: 17, bottom: 23, left: 29 };
const nativeInsets: Insets = { top: 13, right: 19, bottom: 27, left: 31 };

async function renderLayouts(): Promise<{
  browser: Layout;
  native: Layout;
}> {
  const mobileRoot = resolve(import.meta.dirname, "../..");
  const electron = resolve(
    mobileRoot,
    `node_modules/.bin/electron${process.platform === "win32" ? ".cmd" : ""}`,
  );
  const fixture = resolve(import.meta.dirname, "mobile-layout.browser.mjs");
  const electronCommand = [
    electron,
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    fixture,
  ];
  const command =
    process.platform === "linux"
      ? ["xvfb-run", "--auto-servernum", ...electronCommand]
      : electronCommand;
  const child = Bun.spawn(command, {
    cwd: mobileRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`layout browser exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as { browser: Layout; native: Layout };
}

function expectRect(rect: Rect, expected: Insets): void {
  expect(rect.top).toBe(expected.top);
  expect(rect.right).toBe(expected.right);
  expect(rect.bottom).toBe(expected.bottom);
  expect(rect.left).toBe(expected.left);
}

function expectLayout(layout: Layout, insets: Insets): void {
  const safeBounds = {
    top: insets.top,
    right: layout.viewport.width - insets.right,
    bottom: layout.viewport.height - insets.bottom,
    left: insets.left,
  };

  expectRect(layout.auth.root, {
    top: 0,
    right: layout.viewport.width,
    bottom: layout.viewport.height,
    left: 0,
  });
  expectRect(layout.auth.probe, {
    top: safeBounds.top + 24,
    right: safeBounds.right - 20,
    bottom: safeBounds.bottom - 24,
    left: safeBounds.left + 20,
  });

  expectRect(layout.authenticated.root, {
    top: 0,
    right: layout.viewport.width,
    bottom: layout.viewport.height,
    left: 0,
  });
  expect(layout.authenticated.topbar.top).toBe(safeBounds.top);
  expect(layout.authenticated.actions.bottom).toBe(safeBounds.bottom);
  for (const rect of [
    layout.authenticated.topbar,
    layout.authenticated.surface,
    layout.authenticated.actions,
  ]) {
    expect(rect.left).toBe(safeBounds.left);
    expect(rect.right).toBe(safeBounds.right);
    expect(rect.top).toBeGreaterThanOrEqual(safeBounds.top);
    expect(rect.bottom).toBeLessThanOrEqual(safeBounds.bottom);
  }
  expect(layout.authenticated.hostedRoot).toEqual(layout.authenticated.surface);
}

describe("mobile safe-area layout", () => {
  test("enables Capacitor's Android CSS inset fallback", () => {
    expect(capacitorConfig.plugins?.SystemBars).toMatchObject({
      insetsHandling: "css",
    });
  });

  test("keeps both mobile layouts inside all safe-area edges", async () => {
    const layouts = await renderLayouts();

    expectLayout(layouts.browser, browserInsets);
    expectLayout(layouts.native, nativeInsets);
  }, 20_000);
});
