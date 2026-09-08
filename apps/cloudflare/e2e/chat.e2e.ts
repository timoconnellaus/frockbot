// Seams S5 (application Worker → Bot Durable Object turns and runs), S7 (the
// provider) and S9 (the client's HTTP error decoding).
//
// The client never holds a transcript stream open: it POSTs the Turn and reads
// the run back, woken by the Bot-state channel.
//
// Incident 5 is the second half: a Connection that reached `ready` stops
// working when the key is revoked upstream. The failure has to survive as
// durable state and reach the conversation as a readable reason, not as a
// spinner that never ends.
//
// One thing about this client shapes every test below. Chat is the Bot's
// words, and the Bot's words are what it sent: the thread draws one bubble per
// `send_to_user` and nothing for a Turn whose model only wrote text to itself.
// So a spec that wants a visible reply scripts one, which is also why a reply
// can be given words of the spec's own choosing rather than the stub's.
import {
  test,
  expect,
  answerInputs,
  composerInput,
  createBot,
  press,
  pressDisabled,
  revealSidebar,
  sem,
  setFakeOllamaChatMode,
  shareProvisionedApplication,
  spokenText,
} from "./fixtures.ts";
import { E2E_ASSISTANT_REPLY, e2eToolCallPrompt } from "./harness.ts";
// The send route's own rule, read from the module that enforces it: a spec
// that restated the number would keep passing after the limit moved.
import {
  TURN_TEXT_MAX_CHARACTERS_V1,
  TURN_TOO_LONG_MESSAGE_V1,
} from "../src/request-body.ts";
// Same rule for the failure copy: the sentence lives in one place, and the
// spec reads it from there rather than restating it.
import {
  failureNoticeV1,
  RUN_FAILURE_COPY_V1,
} from "@frockbot/app/shell/run-failure-copy";
import type { Locator, Page } from "@playwright/test";

/*
 * One account, one browser, one walk through provisioning, for the whole file.
 *
 * Every test here is about what a Bot does in a conversation, and none of them
 * is about the account it happens in: they used to boot the client and walk
 * `provisionThroughUi` eleven times over to reach the same place. Each test
 * makes a Bot of its own instead, which is the fresh conversation it needs.
 */
const application = shareProvisionedApplication({ botName: "First" });

/*
 * The chat mode belongs to this file's own Connection endpoint, so a mode a
 * test switched on is invisible to every other spec in the run — but not to
 * the test after this one, which shares that endpoint. It is switched off here
 * rather than on a test's own last line: a test that fails mid-Turn never
 * reaches its last line. Leaving `unauthorized` on made every later test's
 * Turn fail with a 401 it never asked for; leaving `streaming` on made every
 * later test wait out the gap in the middle of every reply until it ran out of
 * time. Both read as a regression in whatever ran next.
 */
test.afterEach(async () => {
  const { page, ollamaBaseUrl } = application();
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
});

/** A prompt that makes the stub say `text` to the person, in the Bot's voice. */
function says(text: string): string {
  return e2eToolCallPrompt("send_to_user", {
    disposition: "finish",
    payload: { type: "text", text },
  });
}

/** Every bubble the Bot sent, in the order it sent them. */
function sends(page: Page): Locator {
  return sem(page, "chat-transcript").locator(
    '[flt-semantics-identifier*=":send:"]',
  );
}

/**
 * What each of those bubbles says.
 *
 * A bubble's node carries the avatar's own label as well as the words, so the
 * text of a reply from the Bot reads "Bot\npong". The label is who is
 * speaking, which every bubble in the thread has in common; what is asserted
 * here is what was said.
 */
async function sendTexts(page: Page): Promise<string[]> {
  return (await sends(page).allTextContents()).map((text) =>
    text.replace(/^Bot\s*/, "").trim(),
  );
}

/** Every message the person wrote. */
function saidByUser(page: Page): Locator {
  return sem(page, "chat-transcript").locator(
    '[flt-semantics-identifier$=":user"]',
  );
}

/**
 * The thread with the person's own messages taken out of it.
 *
 * A spec scripts the stub by putting a tool-call line in the message it sends,
 * and the thread shows a person their own words back — so the words "send_to_
 * user" are in the transcript because *they* typed them. What a claim about
 * what the conversation says of a tool means is what it says that nobody typed.
 */
async function transcriptWithoutTheUser(page: Page): Promise<string> {
  const transcript = (await sem(page, "chat-transcript").textContent()) ?? "";
  const mine = await saidByUser(page).allTextContents();
  return mine.reduce((text, said) => text.split(said).join(""), transcript);
}

/**
 * The thread as the reader sees it, top to bottom.
 *
 * A canvas has no document order to read a transcript off, and the engine puts
 * its nodes in the tree in whatever order it built them. Where a line sits is
 * the box it was drawn at, so that is what "in order" is asked of here.
 */
async function threadOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const transcript = document.querySelector(
      '[flt-semantics-identifier="chat-transcript"]',
    );
    if (!transcript) return [];
    return [...transcript.querySelectorAll("[flt-semantics-identifier]")]
      .map((node) => ({
        id: node.getAttribute("flt-semantics-identifier") ?? "",
        top: node.getBoundingClientRect().top,
        text: (node.textContent ?? "").replace(/^Bot\n/, "").trim(),
      }))
      .filter((line) => line.id.endsWith(":user") || line.id.includes(":send:"))
      .sort((left, right) => left.top - right.top)
      .map((line) => (line.id.endsWith(":user") ? "you" : `bot: ${line.text}`));
  });
}

/**
 * Type the message and press Send, and return the moment it is pressed.
 *
 * This is the send a spec wants when what it is watching happens *during* the
 * Turn. The composer holds the draft until the client has confirmed delivery,
 * and confirming delivery means the POST has answered — which, on a provider
 * that is holding the model call open, is the whole Turn. So a spec that
 * waited for an empty composer would be looking for the working row after the
 * Turn it belongs to has already settled.
 */
async function beginTurn(page: Page, text: string): Promise<void> {
  // Typed through the retry the engine needs: keys sent before it has opened
  // the field's editing session are dropped, and a draft that arrives with its
  // first characters missing is a different message — which, when the draft
  // carries a tool script, is a different Turn.
  await answerInputs([[composerInput(page), text]]);
  // Send closes while a submission is in flight and while the client is still
  // confirming the last one, and a click on a closed button is a no-op that
  // reads afterwards as a message the product lost. Waiting for it to open
  // again is what "press Send" means.
  await expect
    .poll(() => pressDisabled(sem(page, "send-button")), { timeout: 120_000 })
    .toBe(false);
  await press(sem(page, "send-button"));
}

/** The same, waiting until the client has the Turn the send made. */
async function startTurn(page: Page, text: string): Promise<void> {
  await beginTurn(page, text);
  await expect(composerInput(page)).toHaveValue("", { timeout: 120_000 });
}

/**
 * Send, and wait for the Turn to settle.
 *
 * Local rather than `fixtures.sendMessage` because what settles a Turn here is
 * the reply arriving, not a row count. The thread is a reversed, virtualised
 * list: a message that has scrolled above the fold leaves the accessibility
 * tree altogether, so counting rows counts what is on screen rather than what
 * was said, and a conversation of six Turns is one short of its own arithmetic
 * through no fault of the product.
 *
 * What is on screen is where a new reply lands, so the settled claim is that
 * the Bot's bubbles have changed and the working row has gone.
 */
async function send(
  page: Page,
  text: string,
  options: { replies?: number } = {},
): Promise<void> {
  const replies = options.replies ?? 0;
  const before = replies > 0 ? await sendTexts(page) : [];
  await startTurn(page, text);
  if (replies > 0) {
    await expect
      .poll(() => sendTexts(page), { timeout: 120_000 })
      .not.toEqual(before);
  }
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
}

test("Turns stay ordered, render Markdown, and survive a reload", async () => {
  const { page } = application();
  await createBot(page, "Talker");

  const firstReply = "Rendered **this** for you";
  const secondReply = "And _that_ as well";
  await send(page, `first\n${says(firstReply)}`, { replies: 1 });

  // The row and the transcript are two renderings of the same Turn, so the
  // *first* settled Turn has to move both. The sidebar used to re-read only on
  // its fifteen-second poll, so a Bot's first reply left the row reading "No
  // messages yet" — in practice until the Turn after it. This timeout is
  // deliberately under that interval: a row that only a poll could have
  // refreshed fails here, and no reload is involved.
  await revealSidebar(page);
  const sidebarRow = sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: "Talker" });
  // The row's line is what the Bot *said* — the last explicit send of the
  // Turn — and never the model's own text, which is private whatever the row
  // has room for. It is the durable preview the server projects, so it is the
  // words rather than the rendering: the thread draws the Markdown, the row
  // repeats the sentence.
  await expect(sidebarRow).toContainText(firstReply, { timeout: 10_000 });
  await expect(sidebarRow).not.toContainText("No messages yet");

  await send(page, `second\n${says(secondReply)}`, { replies: 1 });

  // The Bot's words are Markdown the client rendered, not escaped text: what
  // is on screen is the emphasis, and the asterisks are gone.
  await expect
    .poll(() => sendTexts(page))
    .toEqual(["Rendered this for you", "And that as well"]);
  const expectedOrder = [
    "you",
    "bot: Rendered this for you",
    "you",
    "bot: And that as well",
  ];
  await expect.poll(() => threadOrder(page)).toEqual(expectedOrder);

  // A reload replays the conversation from `GET /api/bots/:bot/turns`. Incident
  // 1 was that route answering HTML: the history vanished and the console
  // carried `Unexpected token '<'`, which the `page` fixture would now fail on.
  await page.reload();
  await expect
    .poll(() => sendTexts(page), { timeout: 120_000 })
    .toEqual(["Rendered this for you", "And that as well"]);
  await expect.poll(() => threadOrder(page)).toEqual(expectedOrder);
  await revealSidebar(page);
  // The row survives the reload the same way, on the newest Turn's send.
  await expect(sidebarRow).toContainText(secondReply);
});

test("a Turn that is running when the page reloads still delivers its reply", async () => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Patient");

  // The provider holds the completion open, so the Turn is genuinely running
  // while the browser goes away.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  await answerInputs([
    [composerInput(page), `take your time\n${says("Worth the wait")}`],
  ]);
  await press(sem(page, "send-button"));

  // Reloaded without waiting for the composer to clear, because the wait is
  // the thing being taken away: the reply to the POST is gone from here, this
  // browser has no copy of the Turn, and nobody will re-send it. The provider
  // is holding the completion open, so the Turn is still running.
  await expect(sem(page, "chat-transcript")).toBeVisible();
  await page.reload();

  // The reloaded page finds the Turn still running and converges on the
  // settled reply with no further action from anybody.
  await expect
    .poll(() => sendTexts(page), { timeout: 120_000 })
    .toEqual(["Worth the wait"]);
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
});

// The owner's claim from the chat refinement, in this client's terms: what the
// Bot *sent* reaches the thread while the Turn is still running, and the model
// text that follows the send stays private. The fake provider's `streaming`
// mode writes "PRIVATE MODEL SCRATCH" across a gap on the call after the
// delivery, which is the window this watches.
test("an explicit send appears while model text stays private", async () => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Streamer");

  await setFakeOllamaChatMode(page, ollamaBaseUrl, "streaming");
  await beginTurn(page, "Say it as you think of it");

  // Latched rather than asserted at one instant: the Turn settles on its own
  // schedule, and the claim is that the delivered send was drawn while the
  // private model continuation was still going.
  let sawSendWhileRunning = false;
  await expect
    .poll(
      async () => {
        if (sawSendWhileRunning) return true;
        const [texts, working] = await Promise.all([
          sendTexts(page),
          sem(page, "working-indicator").count(),
        ]);
        sawSendWhileRunning =
          working > 0 &&
          texts.some((text) => text.includes("local Ollama stub"));
        return sawSendWhileRunning;
      },
      { timeout: 90_000 },
    )
    .toBe(true);

  // Private model streaming never becomes a bubble of its own, and never
  // changes the one the Bot sent.
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  const transcript = (await sem(page, "chat-transcript").textContent()) ?? "";
  expect(transcript).not.toContain("PRIVATE MODEL SCRATCH");
  await expect
    .poll(() => sendTexts(page), { timeout: 120_000 })
    .toEqual([E2E_ASSISTANT_REPLY.replaceAll("**", "")]);
});

// One claim this file used to make is gone, and its absence is deliberate:
// "a reply appears while the Bot is still writing it". The Flutter client
// does not stream. `ChatController` has no poll of its own — `refresh()` runs
// only when the state channel invalidates it — so a run's `partialText`,
// which the wire does carry while a Turn is running, never reaches the
// thread. The Turn's words appear when it settles or not at all. That is a
// parity gap in the client rather than something a spec can phrase around,
// and it wants its own change.

// The thread's shape, not its plumbing: a reply the Bot delivered is drawn
// once. The regression this pins was every block of an assistant Turn laying
// out side by side, which squeezed a one-word reply into a 17px column that
// broke "pong" across two lines and drew it twice.
test("a delivered reply is one bubble, wide enough for its own text", async () => {
  const { page } = application();
  await createBot(page, "Ponger");
  await page.setViewportSize({ width: 1351, height: 831 });

  await send(page, `ping\n${says("pong")}`, { replies: 1 });

  // One reply, whichever way the Turn produced it: the delivered send is the
  // Bot's voice and the model's own text is not drawn beside it (issue 153).
  await expect(sends(page)).toHaveCount(1, { timeout: 120_000 });
  await expect.poll(() => sendTexts(page)).toEqual(["pong"]);

  // The bubble is wider than the word it holds, so the text is on one line.
  // A canvas has no text node to measure a range against, so what is measured
  // is the bubble itself: a one-word reply that wrapped would be two lines
  // tall, and this is comfortably under that.
  const bubble = await sends(page).first().boundingBox();
  expect(bubble, "the reply has no box").not.toBeNull();
  if (!bubble) return;
  expect(
    bubble.width,
    "the reply is drawn narrower than a word",
  ).toBeGreaterThan(40);
  expect(bubble.height, "the reply wrapped onto a second line").toBeLessThan(
    80,
  );

  // The Turn's tool call is not in the transcript in words. The trail off the
  // avatar was the whole of what the conversation said about it, and a settled
  // Turn keeps none.
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  // The person's own message is left out of the reading: the script that told
  // the stub what to say is words *they* typed, and the thread is right to
  // show them back. What is claimed here is that the conversation adds nothing
  // of its own about the call.
  const said = await transcriptWithoutTheUser(page);
  expect(said).not.toMatch(/send_to_user/);
  expect(said).not.toMatch(/tool call/i);
});

// The settled case above, from the other end of a Turn. The avatar used to sit
// in a gutter to the left of the running Turn's bubbles and then vanish when
// the Turn ended, which took the bubble sideways with it. The working row is
// under the bubbles now, so a bubble is at the transcript's left edge while
// the Bot is still writing, the sheep is below it rather than beside it, and
// the end of the Turn moves nothing horizontally.
test("the working avatar sits below the bubbles and never shifts them", async () => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Stacker");
  await page.setViewportSize({ width: 1351, height: 831 });

  // `slow` rather than `streaming`: the fake splits its answer across a gap
  // only when nothing was scripted, and everything here scripts a tool call —
  // so `streaming` settled this Turn in a second and the working row was gone
  // before a poll could see it. Holding every model call open for ten seconds
  // gives the same window from the other side: the Bot's `send_to_user` bubble
  // is drawn when the first call returns, and the second call is still open
  // behind it, which is a bubble and the working row on screen together.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  await beginTurn(page, `say it slowly\n${says("Half a thought")}`);

  // Latched rather than asserted at an instant: the geometry is read the first
  // time a bubble and the working row are both drawn, whenever that happens.
  let running: { bubbleLeft: number; gap: number } | null = null;
  await expect
    .poll(
      async () => {
        const bubble = await sends(page)
          .first()
          .boundingBox()
          .catch(() => null);
        const row = await sem(page, "working-indicator")
          .boundingBox()
          .catch(() => null);
        if (!bubble || !row || bubble.width === 0) return false;
        running = {
          bubbleLeft: bubble.x,
          // How far the row's top is below the bubble's bottom. Negative would
          // mean the two overlap, which is the old side-by-side row.
          gap: row.y - (bubble.y + bubble.height),
        };
        return true;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  const midTurn = running as unknown as { bubbleLeft: number; gap: number };

  // Below, not beside.
  expect(midTurn.gap).toBeGreaterThanOrEqual(0);

  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });

  // The Turn ended and the row went; the bubble did not move.
  const settled = await sends(page).first().boundingBox();
  expect(settled).not.toBeNull();
  expect(settled?.x).toBeCloseTo(midTurn.bubbleLeft, 0);
});

// Tim's report: sending while the Bot is working put the new message *under*
// the working sheep, because the sheep belonged to the running Turn's article
// and the new message was appended after it. The reader watched their own words
// arrive below the animation that was supposedly about to answer them — and the
// Turn they had just replaced was labelled "Interrupted by your next message.",
// which said nothing their own message did not already say.
test("a message sent mid-Turn lands above the working sheep, unlabelled", async () => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Stepper");

  // The provider holds every model call open for ten seconds, which is the
  // window to send into. Not `streaming`, which splits an answer across a gap
  // only for a Turn that scripted no tool call — and this one scripts a reply.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  await beginTurn(page, `first\n${says("Working on it")}`);
  // Wait until the Turn is visibly running before superseding it.
  await expect(sem(page, "working-indicator")).toHaveCount(1, {
    timeout: 90_000,
  });

  await beginTurn(page, "second");

  // While the Turn they replaced is winding down, the row above their message
  // says what is happening to it. It used to say nothing at all, so two Turns
  // of waiting read as one Turn being slow.
  await expect
    .poll(
      async () =>
        ((await sem(page, "chat-transcript").textContent()) ?? "").includes(
          "Stopping the previous reply",
        ),
      { timeout: 90_000 },
    )
    .toBe(true);

  // The order the reader sees: their new message, then the sheep, with nothing
  // of the thread after it.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const transcript = document.querySelector(
            '[flt-semantics-identifier="chat-transcript"]',
          );
          const row = transcript?.querySelector(
            '[flt-semantics-identifier="working-indicator"]',
          );
          if (!transcript || !row) return null;
          const rowTop = row.getBoundingClientRect().top;
          const lines = [
            ...transcript.querySelectorAll("[flt-semantics-identifier]"),
          ].filter((node) => {
            const id = node.getAttribute("flt-semantics-identifier") ?? "";
            return id.endsWith(":user") || id.includes(":send:");
          });
          return {
            everyLineAbove: lines.every(
              (line) => line.getBoundingClientRect().top < rowTop,
            ),
            lines: lines.length,
          };
        }),
      { timeout: 90_000 },
    )
    .toEqual({ everyLineAbove: true, lines: 3 });

  // The superseded Turn is not labelled: the message above explains itself.
  await expect(sem(page, "chat-transcript")).not.toContainText(
    "Interrupted by your next message.",
  );

  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  await expect(sem(page, "chat-transcript")).not.toContainText(
    "Interrupted by your next message.",
  );
  // And the words go with the drain: the new Turn is the one running now.
  await expect(sem(page, "chat-transcript")).not.toContainText(
    "Stopping the previous reply",
  );
});

// Tim's report, as the thread: a Bot that says three things in one Turn leaves
// three messages behind, in the order it said them. Each one used to land in
// the same bubble, so the newest overwrote the one before it and a person
// watching an acknowledgement followed by a result was left with only the
// result.
test("every message the Bot sends is its own bubble, in order", async () => {
  const { page } = application();
  await createBot(page, "Sayer");

  const said = ["On it.", "Looking now.", "Booked."];
  await send(page, ["book it", ...said.map(says)].join("\n"), {
    replies: said.length,
  });

  await expect.poll(() => sendTexts(page), { timeout: 120_000 }).toEqual(said);

  // Durable order is display order: the thread a reload draws is the thread
  // that was watched being written, and no send has been folded into another.
  await page.reload();
  await expect.poll(() => sendTexts(page), { timeout: 120_000 }).toEqual(said);
});

// The owner's ask, from the other side: a Turn that spends its time making
// tool calls has to look like it is working without naming one. The comet
// trail off the Bot's avatar is that — a working row while the Turn runs, gone
// once it settles, and never a word about a tool.
test("a working Bot shows a comet trail beside its avatar, and no tool names", async () => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Ringer");

  // `slow` for the same reason the two specs above use it: the fake's gap is
  // for an answer it wrote itself, and this Turn scripts a reply.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "slow");
  await beginTurn(page, `take your time\n${says("Nearly there")}`);

  // Latched the way the streaming assertion above is: the row is on screen at
  // some point while the Turn runs, never necessarily when a poll happens to
  // look.
  await expect(sem(page, "working-indicator")).toHaveCount(1, {
    timeout: 90_000,
  });

  await expect
    .poll(() => sendTexts(page), { timeout: 120_000 })
    .toEqual(["Nearly there"]);
  // The Turn settled, so the working row and its trail went. The words "tool"
  // and "tool call" were never in the thread at all.
  await expect(sem(page, "working-indicator")).toHaveCount(0, {
    timeout: 120_000,
  });
  // The person's own message is left out: the words that script the stub are
  // theirs, and the thread is right to show them back.
  const said = await transcriptWithoutTheUser(page);
  expect(said).not.toMatch(/tool call/i);
  expect(said).not.toMatch(/send_to_user/);
});

test("a provider that stops accepting the key ends the Turn with a reason", async ({
  allowedFailures,
}) => {
  const { page, ollamaBaseUrl } = application();
  await createBot(page, "Revoked");

  // The key validated, so the Connection is ready; the endpoint then refuses
  // inference, which is what an upstream revocation looks like.
  await setFakeOllamaChatMode(page, ollamaBaseUrl, "unauthorized");

  // A Turn that fails at the provider settles itself and answers with that
  // settlement, so the send is an ordinary 200 carrying a failed run. It used
  // to answer 500 over the top of a Turn that had already recorded its own
  // outcome, which is why these allowances exist; they are kept because a
  // slower run can still see the connection torn down, and an allowance that
  // matches nothing costs nothing.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/turns$/);
  allowedFailures.console.push(/Failed to load resource.*500/);

  // Everything from here runs inside a `finally`, because the endpoint this
  // test switched into refusing is shared by every spec in the shard. A
  // failing assertion used to skip the reset below, and then each later spec's
  // Turns failed with a 401 they never asked for. One failure should report
  // one failure.
  try {
    await startTurn(page, "will not work");

    /*
     * A failed Turn is a notice, not the Bot speaking.
     *
     * The thread used to render the durable failure verbatim in an assistant
     * bubble — `Bot turn ended with outcome model-error`, a provider status
     * code, and on one occasion a run UUID and the words "no durable provider
     * outcome" — styled exactly like something the Bot had said. The reason is
     * still on the run for `/api/debug` and the console; what the User is shown
     * is one line, in the product's own words.
     *
     * Asserted through the constant the product renders from, so the copy and
     * the spec cannot drift apart. A provider refusal ends the Turn
     * `model-error`, and that outcome has its own sentence — naming the model
     * rather than the Bot, because the Bot did nothing wrong.
     */
    const notice = failureNoticeV1(RUN_FAILURE_COPY_V1["model-error"]).notice;
    // Read as a label as well as as text: the notice and the avatar beside it
    // are one merged semantics node, so the engine writes the sentence into
    // the node's `aria-label` rather than leaving it in the tree as text.
    await expect
      .poll(() => spokenText(sem(page, "chat-transcript")), {
        timeout: 120_000,
      })
      .toContain(notice);
    // The sentence used to end by telling the person to try again with nothing
    // to press; the retry is beside it now, and it sends the same message.
    await expect(
      sem(page, "chat-transcript").locator(
        '[flt-semantics-identifier^="retry-turn-"]',
      ),
    ).toBeVisible();
    const transcript = (await sem(page, "chat-transcript").textContent()) ?? "";
    expect(transcript).not.toContain("model-error");
    expect(transcript).not.toContain("outcome");
    expect(transcript).not.toContain("401");
  } finally {
    // Switched off however the test ended, not only when it passed.
    await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  }
});

// Seam S9 from the other side: what the client does with an answer that is not
// a Turn. A 4xx is the server having read the request and refused it, so the
// send is settled — the person's text belongs in the composer they wrote it
// in, and nothing about it belongs in the thread. The regression was a 120 KB
// message drawn as though it had been sent, followed by a spinner over a run
// that was never admitted.
test("a send the server refuses for size keeps the draft and says why", async ({
  allowedFailures,
}) => {
  const { page } = application();
  await createBot(page, "Terse");

  const composer = composerInput(page);

  // The composer holds the same line the route does, so an oversized message
  // never leaves the browser: the count appears and the button closes. The
  // count is what is left rather than what is over, so over the limit it is a
  // negative number.
  // Filled rather than typed: 32,010 keystrokes is minutes of them. `fill`
  // reaches the widget only while the engine is holding an editing session
  // open on the field, so the focus is the part that matters and the read
  // below is what proves the widget took it.
  await composer.focus();
  await composer.fill("x".repeat(TURN_TEXT_MAX_CHARACTERS_V1 + 10));
  // Read off the conversation rather than the field's own node: the count is
  // a line under the composer row, and which semantics node the engine merges
  // it onto is its business rather than this spec's.
  await expect
    .poll(() => spokenText(sem(page, "shell-conversation")), {
      timeout: 60_000,
    })
    .toContain("-10 characters left");
  await expect.poll(() => pressDisabled(sem(page, "send-button"))).toBe(true);
  await answerInputs([[composer, ""]]);

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
  await answerInputs([[composer, prompt]]);
  await sem(page, "send-button").click();

  // The server's own sentence, not "Agent request failed" and not a guess.
  await expect
    .poll(() => spokenText(sem(page, "shell-conversation")), {
      timeout: 60_000,
    })
    .toContain(TURN_TOO_LONG_MESSAGE_V1);
  // The draft is still where it was written.
  await expect(composer).toHaveValue(prompt);
  // No optimistic bubble, and nothing checking on a Turn that never existed.
  await expect(saidByUser(page)).toHaveCount(0);
  await expect(sem(page, "shell-conversation")).not.toContainText(
    "Checking whether your message went through",
  );
});

// The other half of the same question: an answer that never arrives at all.
// Admission really is unknown there, so the client reconciles — but a bounded
// number of times, and then it says the one thing no copy in the product used
// to say, which is that the app could not reach the Bot.
test("a Bot the client cannot reach settles with a reason and a Retry", async ({
  allowedFailures,
}) => {
  const { page } = application();
  await createBot(page, "Unreachable");

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
  await answerInputs([[composer, prompt]]);
  await sem(page, "send-button").click();

  // The bound is several seconds of backoff, and then it settles by itself,
  // saying the thing no copy in the product used to say.
  await expect
    .poll(() => spokenText(sem(page, "shell-conversation")), {
      timeout: 120_000,
    })
    .toContain("Couldn’t confirm your message");

  // Nothing is running, so nothing offers to stop it, and the way to find out
  // what became of the message is offered beside the reason.
  //
  // The words are not handed back to the composer, and deliberately: this
  // client cannot tell a message that never arrived from one the Bot admitted
  // and answered, so putting the text back would invite the person to send it
  // twice. It stays a submission the client is still holding — which is what
  // "Check message status" is about — and the composer is free for whatever
  // they want to say next.
  await expect(sem(page, "stop-button")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(sem(page, "check-delivery")).toBeVisible();
});

test("a conversation opens at its end, and switching back to it does not reload it", async () => {
  const { page } = application();
  await createBot(page, "Long");

  // Long enough that the thread has to scroll: an opening that is already at
  // the end proves nothing on a transcript that fits.
  const prompts = Array.from({ length: 6 }, (_, index) => index + 1);
  for (const turn of prompts) {
    await send(page, `Turn number ${turn}\n${says(`Answer ${turn}`)}`, {
      replies: 1,
    });
  }

  await createBot(page, "Other");
  await expect(composerInput(page)).toHaveValue("");

  /*
   * Switching back must not put the reader through a reload.
   *
   * There is no scroll offset to read off a canvas, and no `fetch` to count
   * that would mean anything once the client keeps its own cache. So the
   * question is asked the way a person would feel it: the read of the
   * transcript is held open for five seconds, and the thread is expected to be
   * whole and at its end inside that window. A client that waited on the
   * network could not be.
   */
  await page.route(
    // Matched on the path rather than by glob, because the read carries a
    // query string only when it asks for a page or a conversation by name.
    (url) => /\/api\/bots\/[^/]+\/turns$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await new Promise((wait) => setTimeout(wait, 5_000));
      await route.fallback();
    },
  );

  await revealSidebar(page);
  await sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: "Long" })
    .click();

  // Drawn from the client's own memory: the newest Turn is on screen while the
  // read that would have fetched it is still held open. Not "all six" — the
  // transcript is virtualised, so what is in the accessibility tree is what is
  // on screen, and a thread long enough to scroll keeps its older Turns out of
  // it by construction. That the newest is there without the network is the
  // whole claim; where it sits is the one below.
  await expect
    .poll(() => sendTexts(page), { timeout: 4_000 })
    .toContain(`Answer ${prompts.length}`);

  // And on screen at its end: the last thing said is inside the window, and
  // the first is above it rather than waiting to be scrolled down to.
  const ends = await page.evaluate(() => {
    const transcript = document
      .querySelector('[flt-semantics-identifier="chat-transcript"]')
      ?.getBoundingClientRect();
    const lines = [
      ...document.querySelectorAll('[flt-semantics-identifier*=":send:"]'),
    ].map((node) => node.getBoundingClientRect().top);
    if (!transcript || lines.length === 0) return null;
    return {
      last: Math.max(...lines),
      first: Math.min(...lines),
      top: transcript.top,
      bottom: transcript.bottom,
    };
  });
  expect(ends, "the thread drew nothing").not.toBeNull();
  if (!ends) return;
  expect(ends.last).toBeLessThanOrEqual(ends.bottom);
  expect(ends.last).toBeGreaterThan(ends.top);
  expect(ends.first).toBeLessThan(ends.top);
});
