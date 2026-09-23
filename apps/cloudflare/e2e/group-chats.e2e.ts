// A Group Chat is made from the sidebar, written in, renamed and reopened.
// The thread's drawing and the composer's rules are the widget tests'; what
// only the real app can show is that the group the sheet creates is the one
// the list reads back, that the thread is the group's own log, and that the
// selection survives a reload the way a Bot's does.
import {
  answerInputs,
  botIdByName,
  createBot,
  expect,
  field,
  openApplication,
  press,
  revealSidebar,
  sem,
  settle,
  spokenText,
  tap,
  test,
} from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

/** Every Group Chat row in the list. */
function groupRows(page: Page): Locator {
  return sem(page, "shell-sidebar").locator(
    '[flt-semantics-identifier^="group-chat-row-"]',
  );
}

test("a Group Chat is made from the list, written in, and renamed", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await createBot(page, "Alpha");
  await createBot(page, "Beta");
  const [alpha, beta] = await Promise.all([
    botIdByName(page, "Alpha"),
    botIdByName(page, "Beta"),
  ]);

  await revealSidebar(page);
  await expect(groupRows(page)).toHaveCount(0);
  await sem(page, "group-chat-create").click();
  const sheet = sem(page, "group-chat-create-sheet");
  await expect(sheet).toBeVisible();
  await settle(page);
  // Two Bots are the least a group holds; the button waits for the second.
  await tap(page, `group-chat-create-member-${alpha}`).click();
  await tap(page, `group-chat-create-member-${beta}`).click();
  await sem(page, "group-chat-create-confirm").click();
  await expect(sheet).toBeHidden({ timeout: 30_000 });

  // Unnamed, it is called by its members, and it opens as it is made.
  const row = groupRows(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Alpha & Beta");
  const pane = sem(page, "group-chat-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("You started the group with Alpha & Beta.");

  // The person's words are the group's first message.
  const composer = field(page, "group-chat-composer");
  await composer.click();
  await page.waitForTimeout(300);
  await answerInputs([[composer, "Plan the launch together."]]);
  await press(sem(page, "group-chat-send"));
  await expect(composer).toHaveValue("", { timeout: 60_000 });
  await expect(
    pane.locator('[flt-semantics-identifier^="group-chat-message-u-"]'),
  ).toContainText("Plan the launch together.");

  // The header's Members opens the sheet where the group is named.
  await sem(page, "group-chat-members-button").click();
  const members = sem(page, "group-chat-members");
  await expect(members).toBeVisible();
  await expect(sem(page, `group-chat-member-${alpha}`)).toBeVisible();
  await expect(sem(page, `group-chat-member-${beta}`)).toBeVisible();
  await settle(page);
  await sem(page, "group-chat-rename").click();
  await answerInputs([[field(page, "group-chat-rename-field"), "Launch"]]);
  await sem(page, "group-chat-rename-save").click();
  await expect(members).toContainText("Launch");
  // A modal sheet takes the list out of the accessibility tree, so the list
  // is read once the sheet is closed.
  await page.keyboard.press("Escape");
  await expect(members).toBeHidden();
  await expect(row).toContainText("Launch");
  // The rename line carries its Undo, so its words are the line's label.
  await expect(async () => {
    expect(await spokenText(pane, { timeout: 1_000 })).toContain(
      "You renamed the group “Launch”.",
    );
  }).toPass({ timeout: 30_000 });

  // A reload reads the group back from the account and reopens it.
  await page.reload();
  await expect(groupRows(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(groupRows(page)).toContainText("Launch");
  await expect(sem(page, "group-chat-pane")).toContainText(
    "Plan the launch together.",
    { timeout: 30_000 },
  );
});
