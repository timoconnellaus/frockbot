// App-wide Voice assistant, browser through both Durable Objects to the
// Gemini-protocol fake and back as transcript, tool activity, and PCM output.
import { expect, provisionThroughUi, test } from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import {
  E2E_VOICE_ANSWER_V1,
  E2E_VOICE_INPUT_V1,
} from "./voice-fake-protocol.ts";

test("Voice talks through Gemini Live, uses read-only tools, then goes quiet", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Listener",
  });

  const toggle = page.getByRole("button", { name: "Turn Voice on" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const surface = page.getByRole("region", { name: "Voice" });
  await expect(surface).toBeVisible();
  await expect(surface.getByText(E2E_VOICE_INPUT_V1)).toBeVisible({
    timeout: 60_000,
  });
  await expect(surface.getByText("Checked your Bots")).toBeVisible({
    timeout: 60_000,
  });
  await expect(surface.getByText(E2E_VOICE_ANSWER_V1)).toBeVisible({
    timeout: 60_000,
  });
  await expect(surface.getByText(/minutes left this month/)).toBeVisible();

  // The production timeout is two minutes. The fake URL shortens only the
  // clock, not the copy or state transition being exercised.
  await expect(
    surface.getByText("Voice went offline after two quiet minutes."),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Turn Voice on" }),
  ).toBeVisible();
});
