// The engine's fallback fonts, as a chat message actually needs them.
//
// The app's own fonts have no "♯", so a message saying "C♯" sends the engine
// looking for a Noto face that does. Its default is fonts.gstatic.com, which
// the app document's `connect-src 'self'` refuses: the glyph was never drawn
// and every such message logged a CSP error. `build-flutter-web.ts` stages the
// engine's whole fallback table beside the build and `flutter_bootstrap.js`
// points the engine at it, so the face comes from this origin instead.
import { writeFile } from "node:fs/promises";

import {
  expect,
  sem,
  sendMessage,
  shareProvisionedApplication,
  test,
} from "./fixtures.ts";
import { e2eToolCallPrompt } from "./harness.ts";

const application = shareProvisionedApplication({ botName: "Tuner" });

const FALLBACK_FONT = /\/_flutter\/[^/]+\/fallback-fonts\/[a-z0-9]+\/v\d+\//u;

test('a message saying "C♯" draws the sharp from a font this origin serves', async ({}, testInfo) => {
  const { page } = application();
  const requested: string[] = [];
  const fonts: { url: string; status: number; cacheControl: string }[] = [];
  const fontWarnings: string[] = [];
  const onRequest = (request: { url(): string }) =>
    requested.push(request.url());
  const onResponse = (response: {
    url(): string;
    status(): number;
    headers(): Record<string, string>;
  }) => {
    if (!FALLBACK_FONT.test(response.url())) return;
    fonts.push({
      url: new URL(response.url()).pathname,
      status: response.status(),
      cacheControl: response.headers()["cache-control"] ?? "",
    });
  };
  // A face that arrived but would not parse is only a warning from the
  // engine, and the glyph stays undrawn all the same.
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "warning" && /\bfont\b/iu.test(message.text())) {
      fontWarnings.push(message.text());
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("console", onConsole);
  try {
    const said = "Tune the low string to C♯.";
    await sendMessage(
      page,
      `tune\n${e2eToolCallPrompt("send_to_user", {
        disposition: "finish",
        payload: { type: "text", text: said },
      })}`,
      { replies: 1 },
    );
    await expect(sem(page, "chat-transcript")).toContainText(said, {
      timeout: 120_000,
    });

    await expect
      .poll(() => fonts.length, {
        timeout: 60_000,
        message: "the engine never asked this origin for a fallback font",
      })
      .toBeGreaterThan(0);
    for (const font of fonts) {
      expect(font.status, `${font.url} was not served`).toBe(200);
      // Staged under the build hash, so as immutable as the engine beside it.
      expect(font.cacheControl, `${font.url} is not cacheable`).toContain(
        "immutable",
      );
    }
    expect(
      requested.filter((url) => url.includes("fonts.gstatic.com")),
      "the engine went to gstatic for a font, which the app origin's CSP refuses",
    ).toEqual([]);
    expect(fontWarnings, "the engine could not use a fallback font").toEqual(
      [],
    );
    // Console errors, a CSP refusal among them, fail the test in the shared
    // application's own check.
    await page.screenshot({
      path: testInfo.outputPath("sharp-drawn-from-origin.png"),
    });
    await writeFile(
      testInfo.outputPath("fallback-font-responses.json"),
      JSON.stringify(fonts, null, 2),
    );
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("console", onConsole);
  }
});
