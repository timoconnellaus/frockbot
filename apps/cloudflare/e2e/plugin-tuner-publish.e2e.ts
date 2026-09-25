// A person asks their Bot for a guitar tuner, and gets one that hears a
// string: the whole of it, on the real routes, from the conversation.
//
// The model is scripted — it writes the tuner the plugins Skill teaches in
// `references/microphone.md`, file for file — and everything after its tool
// calls is real. `plugin_write_file` puts the descriptor, the module and the
// page in the Plugin's source root; `plugin_check` and `plugin_publish` post
// them to the real `apps/applet-build` service; publish stores the page with
// the bridge injected and ends in an approval card that says the page can use
// the microphone. Pressing Approve is what makes it the Bot's: its panel opens
// on the page the Worker serves, the host opens the microphone when the page
// asks, and the page names the note Chromium's fake device is playing.
//
// The build needs Docker. When it is not running this spec fails saying so,
// rather than passing without having built anything.
import { readFileSync } from "node:fs";
import {
  test,
  expect,
  enablePluginAuthoring,
  openBotPage,
  press,
  provisionThroughApi,
  sem,
  settle,
  SHELL_TIMEOUT_MS,
} from "./fixtures.ts";
import { appletBuildAvailableV1, E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import { hearingAnAString } from "./fake-string.ts";
import { botIdOf, expectToolSaid, runTool } from "./publish-journey.ts";
import { publicationJourneyTimeoutMs } from "./suite.ts";

const DESKTOP = { width: 1351, height: 831 } as const;

test.use(hearingAnAString());

/** The tuner as the plugins Skill teaches it, file for file. */
function taughtTuner(): { descriptor: string; module: string; page: string } {
  const reference = readFileSync(
    new URL(
      "../../../app/plugins/skills/plugins/references/microphone.md",
      import.meta.url,
    ),
    "utf8",
  );
  const blocks = (language: string) =>
    [
      ...reference.matchAll(
        new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"),
      ),
    ].map((match) => match[1]!);
  const descriptor = blocks("json").at(-1);
  const module = blocks("ts").at(-1);
  const page = blocks("html")[0];
  if (!descriptor || !module || !page) {
    throw new Error("microphone.md no longer teaches a whole tuner");
  }
  return { descriptor, module, page };
}

test("a Bot builds the guitar tuner its Skill teaches from the conversation, and it hears a string", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  test.setTimeout(publicationJourneyTimeoutMs);
  expect(
    appletBuildAvailableV1(),
    "Docker is not running, so apps/applet-build could not start and no Plugin can be built. Start Docker and run this spec again.",
  ).toBe(true);

  await page.setViewportSize(DESKTOP);
  await enablePluginAuthoring(page, userId);
  await provisionThroughApi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Author",
  });

  // The Bot writes the three files, the page among them.
  const tuner = taughtTuner();
  for (const [path, text] of [
    ["plugin.json", tuner.descriptor],
    ["plugin.ts", tuner.module],
    ["tuner.html", tuner.page],
  ] as const) {
    await runTool(page, "Build me a guitar tuner.", "plugin_write_file", {
      pluginId: "tuner",
      path,
      text,
    });
    await expectToolSaid(page, userId, `Wrote ${path} in tuner`);
  }
  await runTool(page, "Check it.", "plugin_check", { pluginId: "tuner" });
  await expectToolSaid(page, userId, "tuner builds.");
  await runTool(page, "Publish it.", "plugin_publish", {
    pluginId: "tuner",
    purpose: "Tune a guitar by ear from the microphone.",
  });
  await expectToolSaid(page, userId, "asked the User to approve it");

  // The card says what approving allows before the person allows it.
  await expect(
    page
      .getByText(/use your microphone/)
      .or(page.locator('[aria-label*="use your microphone"]'))
      .first(),
  ).toBeVisible({ timeout: 60_000 });
  const approve = page
    .locator('[flt-semantics-identifier^="approval-approve-"]')
    .last();
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await press(approve);
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/bots/${encodeURIComponent(await botIdOf(page, userId))}/plugins`,
        );
        const body = (await response.json()) as {
          plugins: Array<{ pluginId: string; on: boolean; kind: string }>;
        };
        return body.plugins.find((row) => row.pluginId === "tuner");
      },
      { timeout: 60_000, message: "the approved tuner never joined" },
    )
    .toMatchObject({ kind: "authored", on: true });

  // A fresh read of the Bot, whose page now has the Tuner's door.
  await page.reload();
  await expect(sem(page, "shell-conversation")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await settle(page);
  await openBotPage(page);
  await press(sem(page, "bot-page-panel-tuner"));
  const frame = page.locator('iframe[title="Tuner"]').last();
  await expect(frame).toHaveAttribute(
    "src",
    /\/plugin-pages\/[0-9a-f]{64}\.html$/,
  );
  const listening = frame.contentFrame();
  await expect(listening.locator("#listen")).toBeVisible({ timeout: 60_000 });
  await listening.locator("#listen").click();
  await expect(sem(page, "plugin-page-microphone")).toBeVisible({
    timeout: 30_000,
  });
  await expect(listening.locator("#note")).toHaveText("A2", {
    timeout: 30_000,
  });
  await expect(listening.locator("#cents")).toHaveText(/^1\d cents flat$/);
  await press(sem(page, "plugin-page-microphone-stop"));
  await expect(
    listening.getByText("You stopped the microphone.", { exact: true }),
  ).toBeVisible();
});
