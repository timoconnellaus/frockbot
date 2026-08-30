import { expect, test } from "bun:test";

const root = new URL("../..", import.meta.url);

async function text(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

test("Capacitor navigates directly to the configured hosted WebUI", async () => {
  const process = Bun.spawn(
    [
      "bun",
      "-e",
      "import config from './apps/mobile/capacitor.config.ts'; console.log(JSON.stringify(config.server))",
    ],
    {
      cwd: new URL("../../../../", import.meta.url).pathname,
      env: {
        ...Bun.env,
        FROCKBOT_HOSTED_APP_URL: "https://app.example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await process.exited).toBe(0);
  expect(JSON.parse(await new Response(process.stdout).text())).toEqual({
    url: "https://app.example.com",
    cleartext: false,
  });
});

test("the native bundle contains no local product, auth, or backend transport", async () => {
  const [html, packageJson, hostedClient] = await Promise.all([
    text("index.html"),
    text("package.json"),
    Bun.file(new URL("../cloudflare/src/client/index.ts", root)).text(),
  ]);
  expect(html).not.toContain("<script");
  expect(html).not.toContain('id="app"');
  for (const forbidden of [
    "vue",
    "@capacitor/preferences",
    "@capacitor/browser",
    "@capacitor/share",
  ]) {
    expect(packageJson).not.toContain(forbidden);
  }
  expect(hostedClient).not.toContain("mobile_shell");
  expect(hostedClient).not.toContain("mobile-api-request");
  expect(hostedClient).not.toContain("postMessage");
  expect(hostedClient).toContain("await fetch(path");
});
