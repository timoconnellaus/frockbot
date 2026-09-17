// Seam S6 (the app manifest the application Worker produces against the plugin
// catalog decoder the client ships) plus the Bot settings projection of S3.
//
// Incidents 2 and 3 were both here: the producer emitted a Package without a
// `configuration` block, or with a `deployment.applicationHash` the decoder
// refused, and the Bot settings panel came up with an error banner. Producer
// and consumer each had passing unit tests.
//
// The Bot settings panel has no turns list — the conversation is the window
// beside it — so the Turn history assertion lives in `chat.e2e.ts`, and this
// spec asserts the surface itself: Settings is one level under the Bot page,
// behind its gear, and everything that used to be under an Advanced expander
// is on it in the open.
import type { Locator, Page } from "@playwright/test";
import {
  composerInput,
  createBot,
  expect,
  field,
  openBotPage,
  openBotSettings,
  openApplication,
  press,
  sem,
  spokenText,
  SHELL_TIMEOUT_MS,
  test,
  transcriptMessages,
} from "./fixtures.ts";

/**
 * Press a named widget.
 *
 * A `Semantics(identifier:)` around a widget that lays itself out — an
 * `ExpansionTile`, a `Card`'s `ListTile` — reaches the accessibility tree as a
 * container with `pointer-events: none`, and the node that takes the tap is
 * its child. Clicking the identifier itself would land on the canvas behind
 * it, so this presses whichever of the two the engine made tappable.
 */
function tap(scope: Page | Locator, identifier: string) {
  const node = `[flt-semantics-identifier="${identifier}"]`;
  return scope.locator(`${node}[flt-tappable], ${node} [flt-tappable]`).first();
}

/**
 * Let a surface finish arriving before pressing anything on it.
 *
 * Flutter rebuilds the accessibility tree when semantics change rather than
 * once a frame, so a sliding sheet or a pushed page reaches the DOM at its
 * final position while the canvas is still moving — and Playwright's own
 * stability check, which watches that DOM box, sees nothing to wait for. The
 * engine hit-tests a press against the frame it is painting, so a press issued
 * then lands on whatever is passing under the pointer.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/**
 * Give this Bot a Turn to hold, so its conversation has something to load.
 *
 * What the Bot answers is `defaults.e2e.ts`'s subject, not this one's: here it
 * is enough that the Turn was admitted and is in the thread the client reads
 * back.
 */
async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = composerInput(page);
  // Focusing a Flutter text field replaces the DOM input the semantics tree
  // was holding, so a fill issued in the same breath as the click writes to a
  // node the engine has already discarded and the draft stays empty — which
  // leaves the send button disabled, and disabled means no tappable node at
  // all. The whole gesture is retried until the button is there to press.
  await expect(async () => {
    await composerInput(page).click();
    await page.waitForTimeout(300);
    await composerInput(page).fill(text);
    await expect(tap(page, "send-button")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await tap(page, "send-button").click();
  await expect(composer).toHaveValue("", { timeout: 120_000 });
  await expect(transcriptMessages(page).first()).toBeVisible({
    timeout: 120_000,
  });
}

test("Settings is one level under the Bot page, in one card grammar", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Inspected");
  await settle(page);

  // A Bot with history, so the panel is read beside a conversation that had to
  // load rather than beside an empty thread.
  await sendMessage(page, "hello");

  // At this width the panel is a column the shell already draws, and the Bot
  // page — what the Bot is doing — is what it opens on. Settings is not.
  await expect(sem(page, "bot-page").first()).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(sem(page, "bot-settings")).toHaveCount(0);

  await settle(page);
  await openBotSettings(page);
  const panel = sem(page, "bot-settings");

  // The Flock owns what a Bot looks like, so the panel offers the gesture and
  // nothing else: no upload, no crop, no file picker.
  await expect(sem(page, "bot-avatar")).toContainText("Change character");
  await expect(panel.getByText(/upload/iu)).toHaveCount(0);

  const name = field(page, "bot-name");
  // A Flutter text field keeps its value on the canvas and only mirrors it into
  // the nested `<input>` while that input is the focused editor, so the value
  // is read after a click rather than off the painted field.
  await name.click();
  await expect(name).toHaveValue("Inspected");
  await expect(sem(page, "bot-label")).toBeVisible();
  await expect(sem(page, "bot-description")).toBeVisible();
  // Title is an About field like the others now; there is no Advanced to open.
  await expect(sem(page, "bot-title")).toBeVisible();
  await expect(sem(page, "bot-advanced")).toHaveCount(0);
  await expect(sem(page, "bot-info-members")).toHaveCount(0);
  await expect(sem(page, "bot-info-identity")).toHaveCount(0);

  // A switch says what it is in its accessible name; its title is that name
  // unless flipping it does something else as well.
  await expect(sem(page, "bot-pinned")).toHaveAttribute("aria-label", "Pinned");
  await expect(sem(page, "bot-notifications")).toHaveAttribute(
    "aria-label",
    "Notifications",
  );
  await expect(sem(page, "bot-hidden-from-sidebar")).toHaveAttribute(
    "aria-label",
    "Also turns notifications off",
  );

  // No Save button: a change is written as it is made, and the surface says
  // only what became of the write.
  await expect(sem(page, "bot-settings-save")).toHaveCount(0);
  await expect(sem(page, "bot-settings-status")).toHaveCount(1);

  // Capabilities is a door rather than a switchboard, and the account owns the
  // model unless the Package that lets a Bot differ is installed — which ships
  // disabled, so there is no model row to press here.
  await expect(sem(page, "bot-settings-plugins")).toBeVisible();
  await expect(sem(page, "bot-model")).toHaveCount(0);
  // Two rows rather than a tinted panel of two different button shapes.
  await expect(sem(page, "flock-danger-zone")).toBeVisible();
  await expect(sem(page, "flock-archive-bot")).toBeVisible();
  await expect(sem(page, "flock-delete-bot")).toBeVisible();

  // The chevron goes back to the Bot page, where the Routines live.
  await settle(page);
  await press(sem(page, "right-panel-back"));
  await expect(sem(page, "bot-settings")).toHaveCount(0);
  await expect(sem(page, "bot-page").first()).toBeVisible();

  // Routines is a Contribution mounted in the same region, which is the
  // composition this spec is here to prove holds. The Bot page's row is the
  // door; the panel names it and grows a way back.
  await settle(page);
  await press(sem(page, "bot-page-routines-all"));
  await expect(sem(page, "routines-document")).toBeVisible({ timeout: 60_000 });
  expect(await spokenText(sem(page, "shell-right-panel"))).toContain(
    "All Routines",
  );
  await expect(sem(page, "right-panel-back")).toBeVisible();

  // No error banner anywhere on the surface, and — through the `page` fixture
  // — no console error and no failed request during any of it.
  await expect(page.getByText(/couldn’t load/iu)).toHaveCount(0);
});

test("the Bot page is activity, and the panel stack is per Bot", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Busy");
  await settle(page);
  await openBotPage(page);

  // What the Bot is doing: its Routines, with the way to the whole list under
  // the last of them.
  await expect(sem(page, "bot-page-routines-all")).toBeVisible();
  // The panel's floor names the Bot it is about.
  expect(await spokenText(sem(page, "shell-right-panel"))).toContain("Busy");

  // A sub-page is open; switching Bots puts the panel back on the new Bot's
  // page rather than on the last Bot's Settings.
  await press(sem(page, "bot-page-settings").first());
  await expect(sem(page, "bot-settings")).toBeVisible({ timeout: 60_000 });
  await createBot(page, "Other");
  await settle(page);
  await expect(sem(page, "bot-page").first()).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(sem(page, "bot-settings")).toHaveCount(0);
});
