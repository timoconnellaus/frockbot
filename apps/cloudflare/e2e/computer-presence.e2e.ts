// The right-panel Computer card and the full-window viewer it opens, against a
// deployment whose Computer host is not there.
//
// That is the harness on purpose: `COMPUTER_HOST` is declared exactly as
// production declares it, the harness hands the Worker the token to present it
// (see `e2eComputerConfiguredV1`), and nothing answers it — which is what
// production looks like when the dependency is down. So the Bot has a Computer surface — the route answers, the card is
// registered, the phase is `idle` — and no desktop behind it.
//
// What that leaves provable is the shell, the client state machine and the way
// out: the card is on the panel and says what it knows, the first press opens
// the full window, and the window says there is no desktop in the host's own
// words instead of framing one. What it does not leave provable is anything
// downstream of a minted viewer session — the view-only frame, Take control
// and its confirmation, the live preview and the snapshot it settles back to —
// because no session is ever minted. Those claims want a Computer, and
// inventing one in the browser would prove the stub rather than the product.
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, createBot, openApplication, sem } from "./fixtures.ts";
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/**
 * Show the Computer in the right panel.
 *
 * The panel is one region with a segmented control over everything a feature
 * registered into it — Settings, Routines, the Applet canvas, the Computer —
 * and the segment's label is the only name it has.
 */
async function openComputerPanel(page: Page): Promise<void> {
  await sem(page, "shell-right-panel")
    .getByText("Computer", { exact: true })
    .click();
  await expect(sem(page, "computer-card")).toBeVisible({ timeout: 60_000 });
}

test("the right-panel card shows the Computer and expands on first click", async ({
  page,
  userId,
}, testInfo: TestInfo) => {
  test.skip(!CONFIGURED, OTHER_STATE);
  await page.setViewportSize({ width: 1351, height: 859 });
  await openApplication(page, userId);
  await createBot(page, "Watched");

  await openComputerPanel(page);
  const card = sem(page, "computer-card");
  // The card is a button that says what it is for, and under the screen it
  // says what the Computer is doing — here, waiting to be started.
  await expect(card).toContainText("Open computer in full window");
  await expect(card).toContainText("Ready to start");
  // Nothing is being watched: no minted session, so no frame, and the status
  // line under the screen is absent rather than claiming a stale photograph.
  await expect(sem(page, "computer-screen-status")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-desktop.png"),
  });

  // The first press expands the full window. With no desktop to frame it says
  // so, in the words of whatever refused, and offers the read again — rather
  // than an empty frame, or a Take control over nothing.
  await card.click();
  const viewer = sem(page, "computer-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect(viewer).toContainText("No computer");
  await expect(viewer).toContainText("Try again");
  await expect(sem(page, "computer-phase")).toContainText(NO_HOST);
  await expect(sem(page, "computer-take-control")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-expanded.png"),
  });

  // The way out of a full-window surface is the way back: the panel is where
  // it was, and the card now carries what the window learned.
  await page.goBack();
  await expect(card).toBeVisible();
  await expect(card).toContainText(NO_HOST);
});

test("the right-panel Computer card fits the mobile shell", async ({
  page,
  userId,
}, testInfo: TestInfo) => {
  test.skip(!CONFIGURED, OTHER_STATE);
  await openApplication(page, userId);
  await createBot(page, "Pocket");
  // Waiting at a width where the panel is a column is waiting for the Computer
  // to have registered at all: the shell adds it to the panel when the
  // deployment answers for one, and the phone's own list of panels is built
  // once, from whatever had registered when it opened.
  await openComputerPanel(page);
  await page.setViewportSize(PHONE);

  // At this width the right panel is not a column: its entries are pages, and
  // the header names each of them itself rather than offering a list once one
  // of them is opened.
  // The header's, which is the first one in the document. The panel it opens
  // names itself too — with `aria-current` on it, because it is the one being
  // shown — and the desktop leg above has already opened it once, so both are
  // in the tree by the time the width changes.
  await page
    .getByRole("button", { name: "Computer", exact: true })
    .first()
    .click();
  const card = sem(page, "computer-card");
  await expect(card).toBeVisible({ timeout: 60_000 });

  // A page, so the card has the whole width rather than a drawer's slice of it.
  const box = await card.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(PHONE.width - 48);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-mobile.png"),
  });

  // And it opens from here too, onto the same full-window surface.
  await card.click();
  await expect(sem(page, "computer-viewer")).toBeVisible({ timeout: 60_000 });
  await expect(sem(page, "computer-viewer")).toContainText("No computer");
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

  await openComputerPanel(page);
  const card = sem(page, "computer-card");
  await expect(card).toContainText("No computer");
  await expect(card).toContainText("This Bot has no computer");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("computer-presence-unconfigured.png"),
  });

  await card.click();
  await expect(sem(page, "computer-viewer")).toHaveCount(0);
});
