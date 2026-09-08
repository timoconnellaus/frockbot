// One conversation per Bot. There is no "new conversation": the thread a Bot
// has with a person is continuous, so a second Turn joins the first rather
// than starting a thread of its own, and a reload does not divide them.
import {
  test,
  expect,
  provisionThroughUi,
  sem,
  sendMessage,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

for (const reload of [false, true]) {
  test(`one chat retains both Turns${reload ? " after reload" : ""}`, async ({
    page,
    userId,
    ollamaBaseUrl,
  }) => {
    await provisionThroughUi(page, {
      userId,
      apiKey: E2E_OLLAMA_GOOD_API_KEY,
      apiBaseUrl: ollamaBaseUrl,
      botName: "Rememberer",
    });
    await sendMessage(page, "Remember the first message");
    if (reload) await page.reload();
    await sendMessage(page, "And the second message");

    // Read off the transcript rather than the page: a canvas has no document
    // to search, and what a reader can see is what the accessibility tree
    // carries for the thread.
    const transcript = sem(page, "chat-transcript");
    await expect(transcript).toContainText("Remember the first message");
    await expect(transcript).toContainText("And the second message");
    await expect(
      page.getByRole("button", { name: "New conversation", exact: true }),
    ).toHaveCount(0);
  });
}
