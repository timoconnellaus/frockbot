// Seams S1 (browser → gateway auth), S2 (gateway → application Worker via the
// Worker Loader and the R2 artifact) and S3 (gateway → User Durable Object
// settings). Nothing in the repository proved before this layer that the built
// artifact boots in a browser at all: incident 1 shipped because the only
// consumer of that path was a person.
import {
  test,
  expect,
  composerInput,
  createBot,
  openApplication,
} from "./fixtures.ts";

test("a new User creates a first Bot and finds it in the directory", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);

  // The client mounted, which means `/` served the artifact's HTML, `/app.js`
  // was JavaScript and the shell reached the User Durable Object.
  await expect(
    page
      .locator("aside.sidebar")
      .getByRole("button", { name: "Search every Bot's conversations" }),
  ).toBeVisible();
  await expect(
    page.getByText("No Bots yet. Add your first sheep."),
  ).toBeVisible();
  // And the window agrees with the directory: before the first Bot exists
  // there is no invented Bot to be broken, and nothing claims the account's
  // model is unavailable.
  const workspace = page.locator("main.workspace");
  await expect(workspace.getByText("Barebones")).toHaveCount(0);
  await expect(workspace.getByText("Model unavailable")).toHaveCount(0);
  await expect(workspace.locator("textarea")).toHaveCount(0);

  await createBot(page, "Shepherd");

  // The directory, and the window that follows the selection.
  await expect(
    page.getByRole("button", { name: /Shepherd/ }).first(),
  ).toBeVisible();
  // Exact: the empty Session's greeting heading also carries the name.
  await expect(
    page.locator("main").getByText("Shepherd", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Shepherd is ready." }),
  ).toBeVisible();
  await expect(page.locator(".workspace-title small")).toHaveText(
    "Auto (recommended) · Flock AI",
  );
  await expect(composerInput(page)).toBeEnabled();
});
