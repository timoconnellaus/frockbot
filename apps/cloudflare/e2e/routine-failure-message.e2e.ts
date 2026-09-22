// A Routine that breaks, in the browser.
//
// The unit tests own the projection and the integration suite owns the durable
// message. What only a browser can show is what the person actually gets: one
// ordinary message in the conversation, naming the Routine, in the product's
// own failure words — and *one* of it — badging the Bot's row while nobody is
// looking at it, and clearing when the conversation is opened. Before this the
// firing was invisible in the thread, and while it was being made visible it
// was drawn twice: the message bubble and, underneath it, the generic
// "something went wrong" row for the same firing.
//
// The firing is the same `routine/run` the panel's Run now sends, started only
// after this spec has left Sol. The provider is already `unauthorized`, so the
// Turn fails the way an upstream revocation makes it fail. A failure that lands
// in the open chat is marked read on arrival and never badges the row — which
// is what happened when Run now was pressed while Sol was still on screen, and
// the revocation answered before the switch.
import {
  test,
  expect,
  createBot,
  createRoutineThroughApi,
  expectReadyToSend,
  provisionThroughApi,
  revealSidebar,
  runRoutineThroughApi,
  sem,
  setFakeOllamaChatMode,
  spokenText,
} from "./fixtures.ts";
import { E2E_OLLAMA_GOOD_API_KEY } from "./harness.ts";
// The sentence lives in one place. A spec that restated it would keep passing
// after the copy moved.
import { RUN_FAILURE_COPY_V1 } from "@frockbot/app/shell/run-failure-copy";
import type { Locator, Page } from "@playwright/test";

/**
 * Where a reviewer's screenshots go. Absent, the spec still asserts
 * everything; only the pictures are skipped.
 */
const evidenceDirectory = process.env.FROCKBOT_E2E_EVIDENCE_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (!evidenceDirectory) return;
  await page.screenshot({ path: `${evidenceDirectory}/${name}.png` });
}

function botRow(page: Page, name: string): Locator {
  return sem(page, "shell-sidebar")
    .locator('[flt-semantics-identifier^="sidebar-bot-"]')
    .filter({ hasText: name });
}

/** A trailing number on a row is the unread badge; see `unread-focus.e2e.ts`. */
const BADGE = /\s\d+\+?$/u;

test("a Routine that breaks says so once, by name, and badges the Bot", async ({
  page,
  userId,
  ollamaBaseUrl,
  allowedFailures,
}) => {
  await page.context().grantPermissions(["notifications"]);
  // A firing whose provider refuses settles itself, and the client can see the
  // torn-down attempt on the way there.
  allowedFailures.requests.push(/\/api\/bots\/[^/]+\/routines/u);
  allowedFailures.console.push(/Failed to load resource.*(40\d|50\d)/u);

  await provisionThroughApi(page, {
    userId,
    apiKey: E2E_OLLAMA_GOOD_API_KEY,
    apiBaseUrl: ollamaBaseUrl,
    botName: "Sol",
  });
  // Somewhere else to be looking while the firing lands, so the message has to
  // badge Sol's row rather than being read on arrival.
  await createBot(page, "Beta");
  await expectReadyToSend(page);

  const routine = await createRoutineThroughApi(page, {
    botName: "Sol",
    name: "Morning brief",
    prompt: "Summarise overnight email.",
    schedule: "0 9 * * *",
  });

  // Beta is the chat on screen before the firing is even queued. At this
  // width a panel sits beside the conversation, so Sol would stay focused for
  // the whole of a Run now click, and the failure would be read before the
  // switch.
  await revealSidebar(page);
  await botRow(page, "Beta").click();
  await expectReadyToSend(page);

  const said = `"Morning brief" did not run: ${RUN_FAILURE_COPY_V1["model-error"]}`;
  try {
    // The Connection validated; the endpoint then refuses inference, which is
    // what a revoked key looks like to a firing.
    await setFakeOllamaChatMode(page, ollamaBaseUrl, "unauthorized");
    await runRoutineThroughApi(page, routine);

    // The broken firing is a message like any other: it counts unread on the
    // Bot nobody is reading.
    await expect(botRow(page, "Sol")).toContainText(/\s1$/u, {
      timeout: 180_000,
    });
    await capture(page, "routine-failure-badge");

    // Opening Sol shows what happened, in the product's own words, naming the
    // Routine.
    await botRow(page, "Sol").click();
    await expect
      .poll(() => spokenText(sem(page, "chat-transcript")), {
        timeout: 120_000,
      })
      .toContain(said);
    await capture(page, "routine-failure-message");

    // Once. The bubble is the whole account of the firing: no second generic
    // error row underneath it, and no provider diagnostic anywhere.
    const transcript = await spokenText(sem(page, "chat-transcript"));
    expect(transcript.split(said).length - 1).toBe(1);
    expect(transcript).not.toContain("model-error");
    expect(transcript).not.toContain("401");
    expect(transcript).not.toContain("outcome");

    // And reading the conversation cleared the badge.
    await revealSidebar(page);
    await expect(botRow(page, "Sol")).not.toContainText(BADGE);
    await capture(page, "routine-failure-badge-cleared");
  } finally {
    // Switched off however this ended: the endpoint is shared by the shard.
    await setFakeOllamaChatMode(page, ollamaBaseUrl, "ok");
  }
});
