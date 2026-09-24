// The Tuner this deployment ships (ADR 0036), switched on for one Bot and
// used as a person would, with nothing intercepted: the Plugins row says what
// its page may hear, the panel read names the page the Worker serves from the
// bundle, and the host opens the microphone — never the page — and draws who
// is listening and the Stop that ends it. The microphone is Chromium's fake
// device playing an A string twelve cents flat, so the page naming the note is
// what proves the rate and the encoding the host hands it are the ones it says.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test,
  expect,
  createBot,
  openApplication,
  openBotPage,
  openBotSettings,
  press,
  sem,
  settle,
  SHELL_TIMEOUT_MS,
  tap,
} from "./fixtures.ts";

const PLUGIN_ID = "tuner";
const A_STRING_HZ = 110 * 2 ** (-12 / 1200);

/** A sustained string as 16-bit mono WAV, whole cycles so its loop is seamless. */
function stringRecording(frequency: number): string {
  const rate = 48_000;
  const cycles = Math.round(frequency * 2);
  const length = Math.round((cycles * rate) / frequency);
  const wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const phase = (2 * Math.PI * cycles * i) / length;
    const sample =
      0.3 * Math.sin(phase) +
      0.15 * Math.sin(2 * phase) +
      0.08 * Math.sin(3 * phase);
    wav.writeInt16LE(Math.round(sample * 32_767), 44 + i * 2);
  }
  const path = join(tmpdir(), "frockbot-e2e-a-string.wav");
  writeFileSync(path, wav);
  return path;
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--use-file-for-fake-audio-capture=${stringRecording(A_STRING_HZ)}`,
    ],
  },
});

test("the Tuner, switched on, hears the microphone through the host, and the host stops it", async ({
  page,
  userId,
}, testInfo) => {
  // Tall enough that every row of the Bot's Plugins page is in the tree.
  await page.setViewportSize({ width: 1351, height: 3000 });
  await openApplication(page, userId);
  await createBot(page, "Tuned");
  await settle(page);

  // Off until switched on, and the row says what switching it on allows.
  await openBotSettings(page);
  await tap(page, "bot-settings-plugins").click();
  await expect(sem(page, "plugins-document")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(
    page
      .getByText("Its page can use your microphone while you have it open.")
      .or(
        page.locator(
          '[aria-label*="Its page can use your microphone while you have it open."]',
        ),
      )
      .first(),
  ).toBeVisible();
  const tunerSwitch = page.getByRole("switch", { name: "Tuner", exact: true });
  await expect(tunerSwitch).toHaveAttribute("aria-checked", "false");
  await tunerSwitch.click();
  await expect(tunerSwitch).toHaveAttribute("aria-checked", "true", {
    timeout: 60_000,
  });
  await page.screenshot({ path: testInfo.outputPath("tuner-switched-on.png") });

  await page.setViewportSize({ width: 1351, height: 831 });
  await settle(page);
  await openBotPage(page);
  await press(sem(page, `bot-page-panel-${PLUGIN_ID}`));

  const frame = page.locator('iframe[title="Tuner"]').last();
  // Served by the Worker from the bundle, at the app's own origin.
  await expect(frame).toHaveAttribute(
    "src",
    /\/plugin-pages\/[0-9a-f]{64}\.html$/,
  );
  // The page never holds the microphone itself: its frame is granted nothing.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("allow", /.+/);
  const tunerPage = frame.contentFrame();
  await expect(tunerPage.locator("#listen")).toBeVisible({ timeout: 60_000 });

  await tunerPage.locator("#listen").click();
  // The host opened it, and says so in its own chrome, outside the page.
  const inUse = sem(page, "plugin-page-microphone");
  await expect(inUse).toBeVisible({ timeout: 30_000 });
  await expect(
    tunerPage.getByText("Listening.", { exact: true }),
  ).toBeVisible();
  // The string is heard through the bridge, frame after frame, as itself.
  await expect(tunerPage.locator("#note")).toHaveText("A2", {
    timeout: 30_000,
  });
  await expect(tunerPage.locator("#cents")).toHaveText(/^1\d cents flat$/);
  await expect
    .poll(async () =>
      Number(await tunerPage.locator("#status").getAttribute("data-frames")),
    )
    .toBeGreaterThan(10);
  await page.screenshot({ path: testInfo.outputPath("tuner-listening.png") });

  // The host's Stop ends it, and the page is told why.
  await press(sem(page, "plugin-page-microphone-stop"));
  await expect(inUse).toBeHidden();
  await expect(
    tunerPage.getByText("You stopped the microphone.", { exact: true }),
  ).toBeVisible();
  const heard = Number(
    await tunerPage.locator("#status").getAttribute("data-frames"),
  );
  await page.waitForTimeout(500);
  expect(
    Number(await tunerPage.locator("#status").getAttribute("data-frames")),
  ).toBe(heard);
});
