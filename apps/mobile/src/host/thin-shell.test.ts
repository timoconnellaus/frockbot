import { expect, test } from "bun:test";

const workspace = new URL("../../../../", import.meta.url).pathname;

test("Capacitor navigates directly to the configured hosted WebUI", async () => {
  const process = Bun.spawn(
    [
      "bun",
      "-e",
      "import config from './apps/mobile/capacitor.config.ts'; console.log(JSON.stringify({ server: config.server, includePlugins: config.includePlugins }))",
    ],
    {
      cwd: workspace,
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
    server: {
      url: "https://app.example.com",
      cleartext: false,
    },
    includePlugins: [],
  });
});

test("the native package declares only thin-shell dependencies", async () => {
  const manifest = (await Bun.file(
    new URL("../../package.json", import.meta.url),
  ).json()) as {
    dependencies: Record<string, string>;
  };
  expect(Object.keys(manifest.dependencies).sort()).toEqual([
    "@capacitor/core",
    "@frockbot/configuration-core",
    "@frockbot/mobile-core",
    "@frockbot/plugin-catalog",
    "@frockbot/plugin-mobile-clipboard",
    "@frockbot/plugin-mobile-notifications",
    "cordis",
  ]);
});
