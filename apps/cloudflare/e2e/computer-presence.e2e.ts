// The Bot page's Computer card and the full-window viewer it opens, against a
// deployment whose Computer host is not there.
//
// That is the harness on purpose: `COMPUTER_HOST` is declared exactly as
// production declares it, the harness hands the Worker the token to present it
// (see `e2eComputerConfiguredV1`), and nothing answers it — which is what
// production looks like when the dependency is down. So the Bot has a Computer surface — the route answers, the card is
// registered, the phase is `idle` — and no desktop behind it.
//
// What that leaves provable is the shell, the client state machine and the way
// out: the card is on the Bot page and says what it knows, one press
// opens the full window with nothing in between, and the window says there
// is no desktop in the host's own words instead of framing one. What it does
// not leave provable is anything
// downstream of a minted viewer session — the view-only frame, Take control
// and its confirmation, the live preview and the snapshot it settles back to —
// because no session is ever minted. Those claims want a Computer, and
// inventing one in the browser would prove the stub rather than the product.
import type { Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  createBot,
  openApplication,
  openBotPage,
  expectNoHorizontalOverflow,
  press,
  sem,
  settle,
} from "./fixtures.ts";
import { e2eComputerConfiguredV1 } from "./harness.ts";

const PHONE = { width: 390, height: 844 } as const;

/**
 * Whether this run's deployment was given a Computer at all.
 *
 * The two states are different products, not a flaky one: a Computer whose
 * host is down still has a card that opens, and a deployment that was never
 * given a Computer has one that says so and opens nothing. Everything below
 * this line is the first; the last spec is the second. `E2E_NO_COMPUTER_HOST=1`
 * swaps which of them runs.
 */
const CONFIGURED = e2eComputerConfiguredV1();

/** Why the other state's specs did not run. */
const OTHER_STATE =
  "E2E_NO_COMPUTER_HOST selected the other deployment: this spec proves the one it did not run.";

/** What the host says when it cannot be reached at all. */
const NO_HOST = /The Computer host answered|Couldn’t read the computer/u;

/**
 * Open the desktop.
 *
 * Conversation chrome no longer carries Computer. The Bot page's card is the
 * way in at every width: already showing in the desk column, or one tap of
 * the panel switch on a phone.
 */
async function openComputerViewer(page: Page): Promise<void> {
  await openBotPage(page);
  await press(sem(page, "bot-page-computer"));
  await expect(sem(page, "computer-viewer")).toBeVisible({ timeout: 60_000 });
}

test("the Bot page card opens the desktop itself", async ({
  page,
  userId,
}, testInfo: TestInfo) => {
  test.skip(!CONFIGURED, OTHER_STATE);
  await page.setViewportSize({ width: 1351, height: 859 });
  await openApplication(page, userId);
  await createBot(page, "Watched");

  // The Bot page's card says what the Computer is doing before anything is
  // pressed: a dot, the state, and the way in.
  const status = sem(page, "computer-screen-status");
  await expect(status).toBeVisible({ timeout: 60_000 });
  // The row is one merged node — a dot, the state and the way in — so what it
  // says is its accessible name rather than its text.
  await expect(status).toHaveAttribute("aria-label", /Ready to start/u);
  await expect(sem(page, "bot-page-computer")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-desktop.png"),
  });

  // The Bot page's card opens the desktop itself. There is no page between
  // the two carrying a smaller copy of the same frame: one press, one window.
  await openComputerViewer(page);
  const viewer = sem(page, "computer-viewer");
  // With no desktop to frame it says so, in the words of whatever refused, and
  // offers the read again — rather than an empty frame, or a Take control over
  // nothing.
  await expect(viewer).toContainText("No computer");
  await expect(viewer).toContainText("Try again");
  await expect(sem(page, "computer-phase")).toContainText(NO_HOST);
  await expect(sem(page, "computer-take-control")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-expanded.png"),
  });

  // Reading again against a host that is still not there keeps the window and
  // the sentence: a retry that cannot succeed must not look like one that did.
  await viewer.getByRole("button", { name: "Try again" }).click();
  await expect(viewer).toContainText("No computer");
  await expect(sem(page, "computer-phase")).toContainText(NO_HOST);

  // The way out of a full-window surface is the way back: the Bot page is
  // where it was, and its card now carries what the window learned.
  await page.goBack();
  const card = sem(page, "computer-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("group", { name: NO_HOST })).toBeVisible();
  // Said once: the window's title carries the phase as its subtitle, and
  // nothing outside that window repeats it.
  await expect(sem(page, "computer-phase")).toHaveCount(0);

  // And the card's own way in lands in the same window on the same session.
  await card.click();
  await expect(sem(page, "computer-viewer")).toBeVisible({ timeout: 60_000 });
});

test("the Computer opens to the same window on the mobile shell", async ({
  page,
  userId,
}, testInfo: TestInfo) => {
  test.skip(!CONFIGURED, OTHER_STATE);
  await openApplication(page, userId);
  await createBot(page, "Pocket");
  await page.setViewportSize(PHONE);
  // The desk column leaves; Computer is on the Bot page, opened from the
  // panel switch.
  await expect(sem(page, "bot-page")).toHaveCount(0);
  await settle(page);

  await openComputerViewer(page);
  const viewer = sem(page, "computer-viewer");
  await expect(viewer).toContainText("No computer");
  await expect(viewer).toContainText("Try again");
  // A window, not a drawer's slice of one.
  const box = await viewer.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 48);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-mobile.png"),
  });

  // And back is back: the conversation, with nothing of the window left over.
  await page.goBack();
  await expect(sem(page, "computer-viewer")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

// The other deployment: no Computer was ever configured for it, which is the
// answer a Bot on a deployment without one has to give. It is a sentence, not
// a failure — and a card that says it opens nothing, because a full window
// repeating it would be a tap that answers nothing.
test("a deployment with no Computer says so and opens nothing", async ({
  page,
  userId,
}, testInfo: TestInfo) => {
  test.skip(CONFIGURED, OTHER_STATE);
  await page.setViewportSize({ width: 1351, height: 859 });
  await openApplication(page, userId);
  await createBot(page, "Bare");

  const card = sem(page, "computer-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The row is one merged node — a dot, the state and the way in — and what it
  // says is that node's accessible name, which the engine groups onto a child
  // of the card rather than onto the card itself. So the card says "No
  // computer", and it says it there.
  await expect(card.getByRole("group", { name: /No computer/u })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-unconfigured.png"),
  });

  // There is nothing behind the card to open, so it is inert: not a button, no
  // pointer events on its node, and a click there is refused as intercepted.
  // What a user does is tap where the card is drawn, so the press goes to its
  // coordinates — and it lands on nothing that opens a window.
  const box = await card.boundingBox();
  expect(box, "the card has no box to tap").not.toBeNull();
  if (!box) return;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await settle(page);
  await expect(sem(page, "computer-viewer")).toHaveCount(0);
});
