// Seams S5 (application Worker → Bot Durable Object turns and runs), S7 (the
// provider) and S9 (the client's HTTP error decoding).
//
// There is no SSE or WebSocket here: the client POSTs the Turn and polls the
// run, so every assertion is on the settled reply rather than on a stream.
//
// Incident 5 is the second half: a Connection that reached `ready` stops
// working when the key is revoked upstream. The failure has to survive as
// durable state and reach the conversation as a readable reason, not as a
// spinner that never ends.
import {
  test,
  expect,
  provisionThroughUi,
  sendMessage,
  setFakeOllamaChatMode,
} from "./fixtures.ts";
import { E2E_ASSISTANT_REPLY, E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";

test("Turns stay ordered, render Markdown, and survive a reload", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Talker",
  });

  const firstPrompt = "Render **this** please";
  const secondPrompt = "Then render _that_ too";
  await sendMessage(page, firstPrompt);
  await sendMessage(page, secondPrompt);

  const thread = page.locator("main");
  await expect(thread.getByText(firstPrompt)).toBeVisible();
  await expect(thread.getByText(secondPrompt)).toBeVisible();
  // The assistant reply is Markdown the client rendered, not escaped text.
  const renderedMarkdown = thread.locator(".message-assistant strong", {
    hasText: "local Ollama stub",
  });
  await expect(renderedMarkdown).toHaveCount(2);
  await expect(renderedMarkdown.first()).toBeVisible();

  const turnOrder = () =>
    thread
      .locator("article.message-user, article.message-assistant")
      .evaluateAll((messages) =>
        messages.map((message) => ({
          role: message.classList.contains("message-user")
            ? "user"
            : "assistant",
          text: message.textContent?.trim(),
        })),
      );
  const expectedOrder = [
    { role: "user", text: firstPrompt },
    { role: "assistant", text: "Reply from the local Ollama stub." },
    { role: "user", text: secondPrompt },
    { role: "assistant", text: "Reply from the local Ollama stub." },
  ];
  await expect.poll(turnOrder).toEqual(expectedOrder);

  // The row is the Bot Durable Object's small settled preview projection, not
  // a copy scraped out of the open thread. Its time is present beside the name.
  const sidebarRow = page.locator(".flock-bot-row", {
    has: page.getByText("Talker", { exact: true }),
  });
  await expect(sidebarRow).toContainText(E2E_ASSISTANT_REPLY, {
    timeout: 30_000,
  });
  await expect(sidebarRow.locator("time")).not.toHaveText("");

  // A reload replays the conversation from `GET /api/bots/:bot/turns`. Incident
  // 1 was that route answering HTML: the history vanished and the console
  // carried `Unexpected token '<'`, which the `page` fixture would now fail on.
  await page.reload();
  await expect(thread.getByText(firstPrompt)).toBeVisible();
  await expect(thread.getByText(secondPrompt)).toBeVisible();
  await expect(renderedMarkdown).toHaveCount(2);
  await expect(renderedMarkdown.first()).toBeVisible();
  await expect.poll(turnOrder).toEqual(expectedOrder);
  await expect(sidebarRow).toContainText(E2E_ASSISTANT_REPLY);
});

test("a provider that stops accepting the key ends the Turn with a reason", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Revoked",
  });

  // The key validated, so the Connection is ready; the endpoint then refuses
  // inference, which is what an upstream revocation looks like.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "unauthorized");

  // Submitting a Turn that fails at the provider answers 500 with the durable
  // failure as JSON. That is the designed report of a failed Turn — the reason
  // below is read out of it — so this one request, and the browser's console
  // note about it, are expected.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/turns$/);
  allowedFailures.console.push(/Failed to load resource.*500/);

  await sendMessage(page, "will not work");

  await expect(page.locator(".message-assistant").last()).toContainText(
    "Bot turn ended with outcome model-error",
  );
  await expect(page.locator(".message-assistant").last()).toContainText("401");
});
