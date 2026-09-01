// Seams S1 (browser → gateway auth), S2 (gateway → application Worker via the
// Worker Loader and the R2 artifact) and S3 (gateway → User Durable Object
// settings). Nothing in the repository proved before this layer that the built
// artifact boots in a browser at all: incident 1 shipped because the only
// consumer of that path was a person.
import { test, expect, createBot, openApplication } from "./fixtures.ts";

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

  await createBot(page, "Shepherd");

  // The directory, and the window that follows the selection.
  await expect(
    page.getByRole("button", { name: /Shepherd/ }).first(),
  ).toBeVisible();
  await expect(page.locator("main").getByText("Shepherd")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Shepherd is ready." }),
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Choose a model" }),
  ).toBeVisible();
});
