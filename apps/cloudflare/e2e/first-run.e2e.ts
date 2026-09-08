// Seams S1 (browser → gateway auth), S2 (gateway → application Worker via the
// Worker Loader and the R2 artifact) and S3 (gateway → User Durable Object
// settings). Nothing in the repository proved before this layer that the built
// artifact boots in a browser at all: incident 1 shipped because the only
// consumer of that path was a person.
import { test, expect, composerInput, createBot, sem } from "./fixtures.ts";

test("a new User creates a first Bot and finds it in the directory", async ({
  page,
  userId,
}) => {
  await page.goto(`/?as_user=${userId}`);

  // The client booted, which means `/` served the artifact's document, the
  // engine loaded from the content-addressed prefix, and the shell reached the
  // User Durable Object — none of which a unit test can say.
  await expect(sem(page, "shell-sidebar")).toBeVisible({ timeout: 120_000 });
  await expect(sem(page, "sidebar-search")).toBeVisible();

  // Before the first Bot exists there is no invented Bot to be broken, and
  // nothing claims the account's model is unavailable.
  const conversation = sem(page, "shell-conversation");
  await expect(conversation.getByText("No Bots yet")).toBeVisible();
  await expect(conversation.getByText("No model available")).toHaveCount(0);
  await expect(composerInput(page)).toHaveCount(0);

  await createBot(page, "Shepherd");

  // The directory, and the window that follows the selection.
  await expect(sem(page, "shell-sidebar").getByText("Shepherd")).toBeVisible();
  await expect(
    conversation.getByText("What would you like to work on?"),
  ).toBeVisible();
  await expect(composerInput(page)).toBeEnabled({ timeout: 60_000 });
});
