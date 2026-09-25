// `plugin_page_try` runs on the Bot's Computer; this runs the same runner, the
// same stand-in host and the same bridge in this suite's Chromium, against the
// tuner the plugins Skill teaches, so what a Bot tries is what the app runs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import {
  decodePluginPageTryRequestV1,
  PLUGIN_PAGE_STAND_IN_HOST_JS_V1,
  PLUGIN_PAGE_TRY_RUNNER_MJS_V1,
  PLUGIN_PAGE_TRY_THEME_TOKENS_V1,
  pluginPageForTryV1,
  withPluginPageBridgeV1,
  type PluginPageTryResultV1,
} from "@frockbot/core/contracts";

/** The playwright-core this suite's own Playwright runs on. */
function playwrightCore(): string {
  const fromTest = createRequire(
    require.resolve("@playwright/test/package.json"),
  );
  const fromPlaywright = createRequire(
    fromTest.resolve("playwright/package.json"),
  );
  return dirname(fromPlaywright.resolve("playwright-core/package.json"));
}

const require = createRequire(import.meta.url);

function skillTuner(): string {
  const reference = readFileSync(
    new URL(
      "../../../app/plugins/skills/plugins/references/microphone.md",
      import.meta.url,
    ),
    "utf8",
  );
  const html = /```html\n([\s\S]*?)```/.exec(reference)?.[1];
  if (!html) throw new Error("microphone.md has no tuner page");
  return html;
}

function tryPage(
  html: string,
  input: Parameters<typeof decodePluginPageTryRequestV1>[0],
  microphone = true,
): PluginPageTryResultV1 {
  const tried = decodePluginPageTryRequestV1(input);
  const directory = mkdtempSync(join(tmpdir(), "page-try."));
  try {
    writeFileSync(join(directory, "run.mjs"), PLUGIN_PAGE_TRY_RUNNER_MJS_V1);
    writeFileSync(
      join(directory, "request.json"),
      JSON.stringify({
        width: 390,
        height: 700,
        standIn: PLUGIN_PAGE_STAND_IN_HOST_JS_V1,
        steps: tried.steps,
        config: {
          pluginId: "tuner",
          botId: "bot-1",
          surfaceId: "tuner",
          microphone,
          themeTokens: PLUGIN_PAGE_TRY_THEME_TOKENS_V1,
          state: tried.state,
          toolAnswers: tried.toolAnswers,
          html: pluginPageForTryV1(withPluginPageBridgeV1(html)),
        },
      }),
    );
    const output = execFileSync(
      "node",
      [join(directory, "run.mjs"), directory],
      {
        env: {
          ...process.env,
          PAGE_TRY_PLAYWRIGHT: playwrightCore(),
          PAGE_TRY_CHROMIUM: chromium.executablePath(),
        },
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    return JSON.parse(
      output.trim().split("\n").at(-1) ?? "",
    ) as PluginPageTryResultV1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a Bot's try hears the tone it asked for, and sees Stop reset the page", () => {
  const result = tryPage(skillTuner(), {
    state: { a4: 440 },
    steps: [
      { click: "#listen" },
      { tone: { frequency: 196, level: 0.4 } },
      { wait: 1500 },
      { screenshot: "hearing G" },
      { click: "#listen" },
      { wait: 300 },
    ],
  });
  expect(result.greeted).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.steps.every((step) => step.ok)).toBe(true);
  // Listening after the first press, not after the page's own Stop.
  expect(result.steps[0]?.listening).toBe(true);
  expect(result.steps[4]?.listening).toBe(false);
  expect(result.text).toContain("G3");
  expect(result.text).toContain("Listen");
  expect(result.shots.map((shot) => shot.label)).toEqual(["hearing G"]);
});

test("a Plugin that did not declare the microphone is refused it, as in the app", () => {
  const result = tryPage(
    skillTuner(),
    { steps: [{ click: "#listen" }, { wait: 300 }] },
    false,
  );
  expect(result.text).toContain("This Plugin was not allowed the microphone.");
});

test("what the page reports and throws comes back", () => {
  const result = tryPage(
    `<!doctype html><html><head></head><body><button id="go">Go</button><script>
document.getElementById("go").onclick = () => {
  frockbot.log("level 0.004");
  throw new Error("detector blew up");
};
</script></body></html>`,
    { steps: [{ click: "#go" }, { wait: 200 }] },
  );
  expect(result.reports.map((report) => report.text)).toContain("level 0.004");
  expect(
    result.reports.some(
      (report) =>
        report.level === "error" && report.text.includes("detector blew up"),
    ),
  ).toBe(true);
});
