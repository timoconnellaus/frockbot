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
// spec asserts the stripped panel and the sibling entries the region hosts.
import type { Locator, Page } from "@playwright/test";
import {
  composerInput,
  createBot,
  expect,
  field,
  openApplication,
  sem,
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

test("Bot settings follows the GrokBot order and keeps extras under Advanced", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Inspected");
  await settle(page);

  // A Bot with history, so the panel is read beside a conversation that had to
  // load rather than beside an empty thread.
  await sendMessage(page, "hello");

  // At this width the right panel is a column the shell already draws, and Bot
  // settings is the entry it opens on — there is no trigger to press.
  const panel = sem(page, "bot-settings");
  await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

  // The Flock owns what a Bot looks like, so the panel offers the gesture and
  // nothing else: no upload, no crop, no file picker.
  await expect(sem(page, "bot-avatar")).toContainText("Change colour");
  await expect(panel.getByText(/upload/iu)).toHaveCount(0);

  const name = field(page, "bot-name");
  // A Flutter text field keeps its value on the canvas and only mirrors it into
  // the nested `<input>` while that input is the focused editor, so the value
  // is read after a click rather than off the painted field.
  await name.click();
  await expect(name).toHaveValue("Inspected");
  await expect(sem(page, "bot-label")).toContainText(
    "Research, marketing, admin",
  );
  await expect(sem(page, "bot-description")).toBeVisible();
  // A switch says what it is in its accessible name rather than in text beside
  // it, which is where its detail line ends up too.
  await expect(
    sem(page, "bot-pinned").locator('[role="switch"]'),
  ).toHaveAttribute("aria-label", /Pin this Bot to the top of the sidebar/u);
  await expect(
    sem(page, "bot-notifications").locator('[role="switch"]'),
  ).toHaveAttribute(
    "aria-label",
    /Get notified when this Bot finishes or needs input/u,
  );
  await expect(sem(page, "bot-settings-save")).toBeVisible();
  await expect(sem(page, "bot-title")).toHaveCount(0);

  await settle(page);
  await tap(page, "bot-advanced").click();
  await settle(page);
  await expect(sem(page, "bot-title")).toBeVisible();
  await expect(sem(page, "bot-hidden-from-sidebar")).toBeVisible();
  await expect(sem(page, "bot-info-members")).toContainText("Members");
  await expect(sem(page, "bot-info-identity")).toContainText("Named by you");
  // The account owns the model unless the Package that lets a Bot differ is
  // installed, and it ships disabled — so there is no model row to press here.
  await expect(sem(page, "bot-model")).toHaveCount(0);
  await expect(sem(page, "flock-danger-zone")).toBeVisible();

  // Routines is a Contribution mounted beside these settings in the same
  // region, which is the composition this spec is here to prove holds.
  await expect(sem(page, "shell-right-panel")).toContainText("Routines");

  // No error banner anywhere on the surface, and — through the `page` fixture
  // — no console error and no failed request during any of it.
  await expect(page.getByText(/couldn’t load/iu)).toHaveCount(0);
});
