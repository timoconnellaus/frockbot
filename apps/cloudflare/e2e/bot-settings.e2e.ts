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
import {
  createBot,
  expect,
  field,
  openBotPage,
  openBotSettings,
  openApplication,
  press,
  sem,
  sendMessage,
  settle,
  spokenText,
  SHELL_TIMEOUT_MS,
  test,
} from "./fixtures.ts";

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
  await expect(sem(page, "bot-description")).toBeVisible();
  // A Bot is a name and a description; it has no title.
  await expect(sem(page, "bot-title")).toHaveCount(0);
  // Every About field is on the page; there is no Advanced to open.
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

  // Capabilities is a door rather than a switchboard, and every Bot may choose
  // its own model: the Package that lets a Bot differ is platform-owned, so
  // the model row is always there.
  await expect(sem(page, "bot-settings-plugins")).toBeVisible();
  await expect(sem(page, "bot-model")).toBeVisible();
  // Email is a door too: the row reads nothing until its page opens.
  await expect(sem(page, "bot-email")).toBeVisible();
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
