// Composer dictation, end to end (voice plan slice A).
//
// The whole seam under one browser: the wave button in the composer, the
// microphone, the authenticated socket on the gateway, the `VoiceSession`
// Durable Object, the transcription protocol translated in `voice-upstream.ts`,
// the draft written through `ComposerDraftStore`, and finally the ordinary
// send that gets an ordinary Bot reply.
//
// Only the provider is fake, as everywhere else in this layer: the Worker's
// `VOICE_UPSTREAM_URL` points at the harness's auxiliary Worker, which speaks
// OpenAI's realtime transcription vocabulary. The microphone is Chromium's
// generated tone (`--use-fake-device-for-media-stream`), so what is transcribed
// is the fake's deterministic sentence and not the audio — which is the point:
// what is under test is the transport and the composer, not a transcriber.
import {
  test,
  expect,
  assistantMessages,
  composerInput,
  provisionThroughUi,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
import { E2E_DICTATED_TEXT_V1 } from "./voice-fake-protocol.ts";

test("dictating fills the composer, the bin empties it, and the next one sends", async ({
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

  const composer = composerInput(page);
  await expect(composer).toHaveValue("");

  // With nothing to send, the send button *is* the dictate button. That
  // exchange is the whole of the affordance: no new control appears, and none
  // of the composer's chrome moves.
  const dictate = page.getByRole("button", { name: "Dictate a message" });
  await expect(dictate).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(
    0,
  );

  await dictate.click();

  // Capture is running: the status line says so, and the two controls that
  // replace the one button are the bin and the send.
  const discard = page.getByRole("button", { name: "Discard dictation" });
  const send = page.getByRole("button", { name: "Send dictated message" });
  await expect(discard).toBeVisible();
  await expect(send).toBeEnabled({ timeout: 60_000 });

  // Text arrives in the textarea as it is heard — it is the draft, not a
  // separate box, which is what lets it be edited and sent normally.
  await expect(composer).not.toHaveValue("", { timeout: 60_000 });

  // The bin discards it and hands the slot back to the wave button.
  await discard.click();
  await expect(composer).toHaveValue("");
  await expect(dictate).toBeVisible();
  await expect(discard).toHaveCount(0);

  // Dictate again and send. Send commits the audio and waits for the finished
  // transcript, so the message is the punctuated sentence rather than the
  // rough deltas that built it.
  const replies = assistantMessages(page);
  const before = await replies.count();
  await dictate.click();
  await expect(
    page.getByRole("button", { name: "Send dictated message" }),
  ).toBeEnabled({ timeout: 60_000 });
  await expect(composer).not.toHaveValue("", { timeout: 60_000 });
  await page.getByRole("button", { name: "Send dictated message" }).click();

  // From here it is an ordinary Turn: the draft empties, the message is in the
  // durable thread, and the Bot answers.
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  const thread = page.locator("main");
  await expect(thread.getByText(E2E_DICTATED_TEXT_V1)).toBeVisible({
    timeout: 120_000,
  });
  await expect(replies).toHaveCount(before + 1, { timeout: 120_000 });

  // And the microphone is gone: the composer is back to its typing state.
  await expect(
    page.getByRole("button", { name: "Discard dictation" }),
  ).toHaveCount(0);
  await expect(dictate).toBeVisible();
});

test("typing while dictating keeps both, and the message carries the two together", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Scribe",
  });

  const composer = composerInput(page);
  await page.getByRole("button", { name: "Dictate a message" }).click();
  await expect(composer).not.toHaveValue("", { timeout: 60_000 });

  // A typed suffix survives the transcripts that arrive after it: dictation
  // rewrites only the run of text it put there.
  await composer.click();
  await composer.press("End");
  await composer.pressSequentially(" and please hurry");
  await page.getByRole("button", { name: "Send dictated message" }).click();

  const thread = page.locator("main");
  await expect(thread.getByText(/and please hurry/)).toBeVisible({
    timeout: 120_000,
  });
  await expect(thread.getByText(/Testing dictation/)).toBeVisible({
    timeout: 120_000,
  });
});
