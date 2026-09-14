// Seams S1 (browser → gateway auth), S2 (gateway → application Worker via the
// Worker Loader and the R2 artifact) and S3 (gateway → User Durable Object
// settings). Nothing in the repository proved before this layer that the built
// artifact boots in a browser at all: incident 1 shipped because the only
// consumer of that path was a person.
import { test, expect, composerInput, createBot, sem } from "./fixtures.ts";

test("a new User lands in General and can still create a Bot of their own", async ({
  page,
  userId,
}, testInfo) => {
  await page.goto(`/?as_user=${userId}`);

  // The client booted, which means `/` served the artifact's document, the
  // engine loaded from the content-addressed prefix, and the shell reached the
  // User Durable Object — none of which a unit test can say.
  await expect(sem(page, "shell-sidebar")).toBeVisible({ timeout: 120_000 });
  await expect(sem(page, "sidebar-search")).toBeVisible();

  // The account's authority provisioned General on the first directory read,
  // and the shell opened it: no create sheet, no tour.
  const sidebar = sem(page, "shell-sidebar");
  const conversation = sem(page, "shell-conversation");
  await expect(sidebar.getByText("General")).toBeVisible({ timeout: 60_000 });
  await expect(
    conversation.getByText("What would you like to work on?"),
  ).toBeVisible({ timeout: 60_000 });
  await expect(sem(page, "flock-create")).toHaveCount(0);
  await expect(conversation.getByText("No model available")).toHaveCount(0);

  await page.screenshot({ path: testInfo.outputPath("general-first-run.png") });
  await testInfo.attach("general-first-run.png", {
    path: testInfo.outputPath("general-first-run.png"),
    contentType: "image/png",
  });

  // The suggestions that need no feature are always offered, and choosing one
  // only writes the composer.
  await expect(sem(page, "starter-specialist")).toBeVisible();
  await sem(page, "starter-project").click();
  await expect(composerInput(page)).toHaveValue(
    /^Help me plan and complete \[project\]/,
    { timeout: 60_000 },
  );
  await page.screenshot({
    path: testInfo.outputPath("general-project-draft.png"),
  });
  await testInfo.attach("general-project-draft.png", {
    path: testInfo.outputPath("general-project-draft.png"),
    contentType: "image/png",
  });
  const headers = { "x-frockbot-user-id": userId };
  const { generalBotId } = (await (
    await page.request.get("/api/bots/bootstrap", { headers })
  ).json()) as { generalBotId: string };
  expect(generalBotId).toMatch(/^general-[0-9a-f]{16}$/);
  const turns = await page.request.get(
    `/api/bots/${encodeURIComponent(generalBotId)}/turns`,
    { headers },
  );
  expect(turns.status()).toBe(200);
  expect((await turns.json()) as { runs: unknown[] }).toMatchObject({
    runs: [],
  });

  // Every read so far was of one General.
  const directory = await page.request.get("/api/bots", { headers });
  expect(
    ((await directory.json()) as { bots: { botId: string }[] }).bots.map(
      (bot) => bot.botId,
    ),
  ).toEqual([generalBotId]);

  // The ordinary create flow is still how another Bot is added.
  await createBot(page, "Shepherd");
  await expect(sidebar.getByText("Shepherd")).toBeVisible();
  await expect(sidebar.getByText("General")).toBeVisible();
  await expect(
    conversation.getByText("What would you like to work on?"),
  ).toBeVisible();
  await expect(sem(page, "starter-suggestions")).toHaveCount(0);
  await expect(composerInput(page)).toBeEnabled({ timeout: 60_000 });
  await page.screenshot({
    path: testInfo.outputPath("general-and-additional-bot.png"),
  });
  await testInfo.attach("general-and-additional-bot.png", {
    path: testInfo.outputPath("general-and-additional-bot.png"),
    contentType: "image/png",
  });
  const selection = await page.evaluate(
    (id) => localStorage.getItem(`frockbot.native.v1.selection.${id}`),
    userId,
  );
  expect(selection).toBeTruthy();
  expect(selection).not.toBe(generalBotId);
  await page.reload();
  await expect(sem(page, "shell-conversation")).toBeVisible({
    timeout: 120_000,
  });
  await expect(sem(page, "starter-suggestions")).toHaveCount(0);
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`frockbot.native.v1.selection.${id}`),
      userId,
    ),
  ).toBe(selection);
});
