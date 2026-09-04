// Seams S5 (application Worker → Bot Durable Object turns and runs), S7 (the
// provider) and S9 (the client's HTTP error decoding).
//
// The client never holds a transcript stream open: it POSTs the Turn and reads
// the run back, woken by the Bot-state channel and by its own poll. A reply
// still arrives as it is written, because the words the model has produced are
// durable on the run record before the Turn settles.
//
// Incident 5 is the second half: a Connection that reached `ready` stops
// working when the key is revoked upstream. The failure has to survive as
// durable state and reach the conversation as a readable reason, not as a
// spinner that never ends.
import {
  test,
  expect,
  assistantMessages,
  composerInput,
  createBot,
  provisionThroughUi,
  revealSidebar,
  sendMessage,
  setFakeOllamaChatMode,
} from "./fixtures.ts";
import {
  E2E_ASSISTANT_REPLY,
  E2E_OLLAMA_GOOD_API_KEY,
  e2eToolCallPrompt,
} from "./harness.ts";
// The send route's own rule, read from the module that enforces it: a spec
// that restated the number would keep passing after the limit moved.
import {
  TURN_TEXT_MAX_CHARACTERS_V1,
  TURN_TOO_LONG_MESSAGE_V1,
} from "../src/request-body.ts";

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

test("a Turn that is running when the page reloads still delivers its reply", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Patient",
  });

  // The provider holds the completion open, so the Turn is genuinely running
  // while the browser goes away.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");

  const prompt = "Take your time with this one";
  const composer = composerInput(page);
  await composer.fill(prompt);
  await expect(composer).toHaveValue(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  // The composer clears only once the submission is accepted, so the Turn is
  // durable from here.
  await expect(composer).toHaveValue("", { timeout: 120_000 });

  const thread = page.locator("main");
  await expect(thread.getByText(prompt)).toBeVisible({ timeout: 120_000 });
  // The tab that sent the message can stop it. Before the run state reached
  // the client, this button never appeared for the sending tab at all.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({
    timeout: 60_000,
  });

  // The reply to the POST is now gone: this browser has no copy of the Turn
  // and nobody will re-send it.
  await page.reload();

  // The reloaded page finds the Turn still running and says so, then converges
  // on the settled reply with no further action from anybody.
  await expect(thread.getByText(prompt)).toBeVisible({ timeout: 120_000 });
  // The rendered reply, not the Markdown the stub sent.
  await expect(assistantMessages(page).last()).toContainText(
    "Reply from the local Ollama stub.",
    { timeout: 120_000 },
  );
  await expect(
    assistantMessages(page).last().locator(".bot-avatar-live"),
  ).toHaveCount(0, { timeout: 120_000 });

  // The fake provider is one server for the whole worker, so a spec that
  // slowed it down puts it back before the next one runs.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
});

// The reply is drawn as it is written, not only when the Turn settles. The
// provider sends half the answer, waits, then sends the rest; the half the
// person can read has to reach the thread while the Turn is still running.
test("a reply appears while the Bot is still writing it", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Streamer",
  });

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "streaming");

  const prompt = "Say it as you think of it";
  const composer = composerInput(page);
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });

  // Latched rather than asserted at one instant: the Turn settles on its own
  // schedule, and the claim is that the partial answer was drawn at some point
  // before it did — never that it is still partial when the poll runs.
  let sawPartialWhileRunning = false;
  await expect
    .poll(
      async () => {
        const last = assistantMessages(page).last();
        if ((await last.count()) === 0) return false;
        const text = (await last.textContent()) ?? "";
        const live = await last.locator(".bot-avatar-live").count();
        if (
          live > 0 &&
          text.includes("Reply from the") &&
          !text.includes("Ollama stub")
        ) {
          sawPartialWhileRunning = true;
        }
        return sawPartialWhileRunning;
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // And the settled answer replaces the partial one in the same bubble.
  await expect(assistantMessages(page).last()).toContainText(
    "Reply from the local Ollama stub.",
    { timeout: 120_000 },
  );
  await expect(
    assistantMessages(page).last().locator(".bot-avatar-live"),
  ).toHaveCount(0, { timeout: 120_000 });

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
});

// The thread's shape, not its plumbing: a reply the Bot delivered is drawn
// once, in a column beside the avatar, and a bubble is at least as wide as the
// words in it. The regression this pins was every block of an assistant Turn
// laying out side by side, which squeezed a one-word reply into a 17px column
// that broke "pong" across two lines and drew it twice.
test("a delivered reply is one bubble, wide enough for its own text", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Ponger",
  });
  await page.setViewportSize({ width: 1351, height: 831 });

  await sendMessage(
    page,
    `ping\n${e2eToolCallPrompt("send_to_user", {
      payload: { type: "text", text: "pong" },
    })}`,
  );

  const reply = assistantMessages(page).last();
  // One reply, whichever way the Turn produced it: the delivered send is the
  // Bot's voice and the model's own text is not drawn beside it (issue 153).
  const bubbles = reply.locator(".message-bubble, .send-text");
  await expect(bubbles).toHaveCount(1, { timeout: 120_000 });
  await expect(bubbles.first()).toHaveText("pong");

  // The bubble is wider than the word it holds, so the text is on one line.
  const fits = await bubbles.first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return { box: element.getBoundingClientRect().width, text: text.width };
  });
  expect(fits.box).toBeGreaterThanOrEqual(fits.text);
  expect(fits.text).toBeGreaterThan(10);

  // The Turn's tool call is not in the transcript in words. The trail off the
  // avatar was the whole of what the conversation said about it, and a settled
  // Turn keeps none.
  await expect(reply.getByRole("status", { name: "Working" })).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(reply.locator(".tool-chip")).toHaveCount(0);
  await expect(reply).not.toContainText("Send to user");

  // A settled reply carries no avatar either. Every line here is from the same
  // Bot, so a sheep beside each one named nobody; the column starts at the
  // transcript's own left edge instead, with no gutter left behind.
  await expect(reply.locator(".bot-avatar")).toHaveCount(0);
  await expect(reply.locator(".ui-activity-trail")).toHaveCount(0);
  const edges = await reply.evaluate((element) => {
    const column = element.querySelector(".message-column");
    return {
      row: element.getBoundingClientRect().left,
      column: (column ?? element).getBoundingClientRect().left,
    };
  });
  expect(edges.column).toBeCloseTo(edges.row, 0);
});

// The owner's ask, from the other side: a Turn that spends its time making
// tool calls has to look like it is working without naming one. The comet
// trail off the Bot's avatar is that — a working row labelled "Working" while
// the Turn runs, gone once it settles, and never a word about a tool.
test("a working Bot shows a comet trail beside its avatar, and no tool names", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Ringer",
  });

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "streaming");

  const composer = composerInput(page);
  await composer.fill("take your time");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });

  // Latched the way the streaming assertion above is: the trail is on screen
  // at some point while the Turn runs, never necessarily when a poll happens
  // to look.
  let sawTrail = false;
  await expect
    .poll(
      async () => {
        const last = assistantMessages(page).last();
        if ((await last.count()) === 0) return false;
        const working = last.getByRole("status", { name: "Working" });
        if (
          (await working
            .locator('.ui-activity-trail[data-state="running"]')
            .count()) > 0
        ) {
          sawTrail = true;
        }
        return sawTrail;
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(assistantMessages(page).last()).toContainText(
    "Reply from the local Ollama stub.",
    { timeout: 120_000 },
  );
  // The Turn settled, so the working row and its trail went. The words "tool"
  // and "tool calls" were never in the thread at all.
  await expect(
    assistantMessages(page).last().getByRole("status", { name: "Working" }),
  ).toHaveCount(0, { timeout: 120_000 });
  await expect(assistantMessages(page).last()).not.toContainText(/tool call/i);

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
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
    "This Bot couldn't finish its reply. Try again.",
  );

  // The fake endpoint is shared by every spec in the run, so the refusal this
  // test switched on is switched off again: leaving it on made every later
  // spec's Turn fail with a 401 it never asked for.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
});

// Seam S9 from the other side: what the client does with an answer that is not
// a Turn. A 4xx is the server having read the request and refused it, so the
// send is settled — the person's text belongs in the composer they wrote it
// in, and nothing about it belongs in the thread. The regression was a 120 KB
// message drawn as though it had been sent, followed by a spinner over a run
// that was never admitted.
test("a send the server refuses for size keeps the draft and says why", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Terse",
  });

  const composer = composerInput(page);
  const send = page.getByRole("button", { name: "Send message" });

  // The composer holds the same line the route does, so an oversized message
  // never leaves the browser: the count appears and the button closes.
  await composer.fill("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 10));
  await expect(
    page.getByText("10 characters over the 32,000 limit"),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await composer.fill("");

  // A refusal that reaches the client anyway — another tab, an older build, a
  // proxy of its own — is still a refusal, and the answer already says why.
  allowedFailures.console.push(/Failed to load resource.*413/);
  await page.route("**/api/bots/*/turns", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({ error: TURN_TOO_LONG_MESSAGE_V1 }),
    });
  });

  const prompt = "this one is refused";
  await composer.fill(prompt);
  await send.click();

  // The server's own sentence, not "Agent request failed" and not a guess.
  await expect(page.getByRole("alert")).toContainText(TURN_TOO_LONG_MESSAGE_V1);
  // The draft is still where it was written.
  await expect(composer).toHaveValue(prompt);
  // No optimistic bubble, and nothing checking on a Turn that never existed.
  await expect(page.locator("article.message-user")).toHaveCount(0);
  await expect(
    page.getByText("Checking whether your message went through…"),
  ).toHaveCount(0);
});

// The other half of the same question: an answer that never arrives at all.
// Admission really is unknown there, so the client reconciles — but a bounded
// number of times, and then it says the one thing no copy in the product used
// to say, which is that the app could not reach the Bot.
test("a Bot the client cannot reach settles with a reason and a Retry", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Unreachable",
  });

  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/turns/);
  allowedFailures.console.push(/Failed to load resource/);
  // The send, and every reconciliation lookup it would make: this tab can
  // reach nothing about the Turn, which is what a dropped connection looks
  // like from inside the browser.
  await page.route("**/api/bots/*/turns", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.abort("connectionfailed");
  });
  await page.route("**/api/bots/*/turns/**", (route) =>
    route.abort("connectionfailed"),
  );

  const composer = composerInput(page);
  const prompt = "are you there";
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const thread = page.locator("main");
  const reason = thread.getByText(
    "Couldn't reach the Bot. Check your connection and try again.",
  );
  // The bound is several seconds of backoff, and then it settles by itself.
  await expect(reason).toBeVisible({ timeout: 120_000 });

  // The line is under the message it reports on, never above it.
  await expect
    .poll(() =>
      thread
        .locator("article.message-user, article.message-assistant")
        .evaluateAll((messages) =>
          messages.map((message) =>
            message.classList.contains("message-user") ? "user" : "assistant",
          ),
        ),
    )
    .toEqual(["user", "assistant"]);

  // The words wrap inside the bubble rather than being cut off by its width.
  const bubble = page.locator("article.message-assistant .message-bubble");
  const clipped = await bubble.evaluate(
    (element) => element.scrollWidth > element.clientWidth + 1,
  );
  expect(clipped).toBe(false);

  // Nothing is running, so nothing offers to stop it; the draft is back, and
  // the Retry beside the reason is what sends it again.
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0);
  await expect(composer).toHaveValue(prompt);
  await expect(page.getByRole("button", { name: "Retry" })).toBeEnabled();
});

test("a conversation opens at its end, and switching back to it does not reload it", async ({
  page,
  userId,
  ollamaBaseUrl,
}) => {
  await provisionThroughUi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Long",
  });

  // Long enough that the thread has to scroll: an opening that is already at
  // the end proves nothing on a transcript that fits.
  const prompts = Array.from(
    { length: 6 },
    (_, index) => `Turn number ${index + 1}`,
  );
  for (const prompt of prompts) await sendMessage(page, prompt);

  const thread = page.locator("section.thread");
  await expect
    .poll(() =>
      thread.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);

  await createBot(page, "Other");
  await expect(composerInput(page)).toHaveValue("");

  /*
   * Everything this test asks about is true or false at one instant — the
   * moment the thread stops carrying `thread-settling`, which is when it goes
   * from laid-out-but-unpainted to on screen. So it is all sampled there, in
   * the page, rather than read back afterwards from Node where a background
   * revalidation could have landed in between and changed the answer.
   *
   * What is sampled: where the thread is scrolled, how much of the transcript
   * is in it, and how many `GET /turns` reads have *answered* this client. A
   * transcript drawn from the cache is whole and at its end with that count
   * still at zero — it cannot have come from a read that has not returned. The
   * count is of answers rather than of requests on purpose: the design says a
   * restored transcript may be revalidated behind the paint, so a read in
   * flight at this instant is the feature and not the bug.
   *
   * The class is read from each mutation record's `oldValue` rather than from
   * the element, so a slow runner that batches the add and the remove into one
   * callback is still seen as the transition it was.
   */
  await page.evaluate(() => {
    const element = document.querySelector("section.thread");
    if (!element) throw new Error("the thread is missing");
    const marker = "thread-settling";
    const samples: {
      atEnd: boolean;
      distance: number;
      messages: number;
      turnReads: number;
    }[] = [];
    const scope = window as unknown as {
      threadOpenings: typeof samples;
      threadTurnReads: number;
    };
    scope.threadOpenings = samples;
    scope.threadTurnReads = 0;

    const fetchImpl = window.fetch.bind(window);
    const counting = (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const answer = fetchImpl(input, init);
      if (
        method === "GET" &&
        new URL(url, location.href).pathname.endsWith("/turns")
      )
        return answer.then((response) => {
          scope.threadTurnReads += 1;
          return response;
        });
      return answer;
    };
    // The counter stands in for `fetch` itself, so anything hung off the real
    // one — `preconnect` — is carried across rather than dropped.
    window.fetch = Object.assign(counting, window.fetch) as typeof window.fetch;

    new MutationObserver((records) => {
      const left = records.some(
        (record) =>
          record.attributeName === "class" &&
          (record.oldValue ?? "").includes(marker),
      );
      if (!left || element.classList.contains(marker)) return;
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      samples.push({
        atEnd: distance <= 1,
        distance,
        messages: element.querySelectorAll("article.message-user").length,
        turnReads: scope.threadTurnReads,
      });
    }).observe(element, {
      attributes: true,
      attributeFilter: ["class"],
      attributeOldValue: true,
    });
  });

  await revealSidebar(page);
  await page
    .locator(".flock-bot-row", { has: page.getByText("Long", { exact: true }) })
    .click();

  await expect(thread.getByText(prompts[0] ?? "")).toBeVisible();
  await expect(thread.getByText(prompts.at(-1) ?? "")).toBeVisible();

  const openings = await page.evaluate(
    () =>
      (
        window as unknown as {
          threadOpenings: {
            atEnd: boolean;
            distance: number;
            messages: number;
            turnReads: number;
          }[];
        }
      ).threadOpenings,
  );
  const opening = openings[0];
  expect(opening).toBeDefined();
  if (!opening) throw new Error("the thread never opened");
  // The conversation is on screen at its end in the first frame that shows it:
  // no top-of-thread frame, and no scroll for the reader to watch.
  expect(opening.atEnd).toBe(true);
  // Whole, and drawn from the client's own memory: every Turn is on screen
  // while no read of them has answered. That is the reload the User asked not
  // to have — the thread was never empty and never waited on the network.
  expect(opening.messages).toBe(prompts.length);
  expect(opening.turnReads).toBe(0);

  // It stays at the end once visible, rather than settling there afterwards.
  const distance = await thread.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  expect(distance).toBeLessThanOrEqual(1);
});
