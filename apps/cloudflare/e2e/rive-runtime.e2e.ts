// Rive Native's WebAssembly runtime, as the browser actually fetches it.
//
// `main()` awaits `RiveNative.init()` before `runApp`, and on the web that
// loader appends a `<script>` and waits for its `load` event. A script the
// app origin's `script-src 'self'` refuses never fires one, so a runtime
// fetched from a CDN meant `init()` never settled, `main()` never painted a
// frame, and every browser spec timed out on a shell that was still waiting.
// Both halves of the fix are checked here: the runtime is served from this
// origin, and a runtime that never arrives costs the animation rather than
// the window.
import { writeFile } from "node:fs/promises";

import { expect, openApplication, sem, test } from "./fixtures.ts";

/** The staged payload, whatever version `build-flutter-web.ts` named it. */
const RIVE_RUNTIME =
  /\/rive\/[^/]+\/wasm(?:_compatibility)?\/rive_native\.(?:js|wasm)$/u;

async function shellIsPainted(page: Parameters<typeof openApplication>[0]) {
  await expect(
    sem(page, "shell-sidebar").or(sem(page, "sidebar-toggle")).first(),
  ).toBeVisible();
}

test("serves Rive's runtime from this origin and never from a CDN", async ({
  page,
  userId,
}, testInfo) => {
  const requested: string[] = [];
  const runtime: { url: string; status: number; cacheControl: string }[] = [];
  page.on("request", (request) => requested.push(request.url()));
  page.on("response", (response) => {
    if (!RIVE_RUNTIME.test(response.url())) return;
    runtime.push({
      url: new URL(response.url()).pathname,
      status: response.status(),
      cacheControl: response.headers()["cache-control"] ?? "",
    });
  });

  await openApplication(page, userId);
  await shellIsPainted(page);

  expect(
    requested.filter((url) => url.includes("cdn.jsdelivr.net")),
    "the client fetched Rive's runtime from a CDN the app origin's CSP refuses",
  ).toEqual([]);
  expect(
    runtime.map((entry) => entry.url),
    "the client never asked this origin for Rive's runtime",
  ).not.toEqual([]);
  for (const entry of runtime) {
    expect(entry.status, `${entry.url} was not served`).toBe(200);
    // A version is an immutable name, so the payload is cacheable for a year.
    expect(entry.cacheControl, `${entry.url} is not cacheable`).toContain(
      "immutable",
    );
  }
  await page.screenshot({
    path: testInfo.outputPath("rive-runtime-served-from-origin.png"),
  });
  await writeFile(
    testInfo.outputPath("rive-runtime-responses.json"),
    JSON.stringify(runtime, null, 2),
  );
});

test("paints the shell even when the runtime never arrives", async ({
  page,
  userId,
}, testInfo) => {
  // A request that is never answered is what a CSP refusal looks like to the
  // loader: no `load`, no `error`, nothing to time out on but the deadline
  // `main()` now puts on `init()`.
  await page.route(RIVE_RUNTIME, () => {});
  const stills: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/characters\/[^/]+\.png$/u.test(request.url())) {
      stills.push(new URL(request.url()).pathname);
    }
  });

  await openApplication(page, userId);
  await shellIsPainted(page);

  // Losing the runtime costs the animation, not the character: a Bot whose
  // animated avatar cannot load shows the checked-in still instead of an
  // empty slot. The image is painted into the canvas, so what the browser
  // fetched is where that is visible from outside.
  await expect
    .poll(() => stills, {
      message: "no Bot fell back to its checked-in still character",
      timeout: 30_000,
    })
    .not.toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("shell-without-the-rive-runtime.png"),
  });
});
