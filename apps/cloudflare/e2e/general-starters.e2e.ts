import {
  test,
  expect,
  sem,
  composerInput,
  answerInputs,
  openApplication,
  openBotPage,
  openBotSettings,
  press,
  settle,
} from "./fixtures.ts";

for (const width of [390, 1280]) {
  test(`General's four starters are editable drafts at width ${width}`, async ({
    page,
    userId,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openApplication(page, userId);
    const headers = { "x-frockbot-user-id": userId };
    const { generalBotId } = await (
      await page.request.get("/api/bots/bootstrap", { headers })
    ).json();
    await expect(sem(page, "starter-research")).toBeVisible();
    await expect(sem(page, "starter-recurring")).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: testInfo.outputPath(`general-${width}.png`),
    });
    await testInfo.attach(`general-${width}.png`, {
      path: testInfo.outputPath(`general-${width}.png`),
      contentType: "image/png",
    });
    for (const [id, draft] of [
      ["research", /^Research \[topic\]/],
      ["project", /^Help me plan and complete \[project\]/],
      ["recurring", /^Every \[weekday morning\]/],
      ["specialist", /^Create a specialist Bot for \[job\]/],
    ] as const) {
      await press(sem(page, `starter-${id}`));
      await expect(composerInput(page)).toHaveValue(draft);
      await answerInputs([[composerInput(page), `Editable ${id} draft`]]);
      await expect(composerInput(page)).toHaveValue(`Editable ${id} draft`);
      const turns = await page.request.get(`/api/bots/${generalBotId}/turns`, {
        headers,
      });
      expect(turns.status()).toBe(200);
      expect(await turns.json()).toMatchObject({ runs: [] });
      await page.screenshot({
        path: testInfo.outputPath(`${id}-edited-${width}.png`),
      });
      await testInfo.attach(`${id}-edited-${width}.png`, {
        path: testInfo.outputPath(`${id}-edited-${width}.png`),
        contentType: "image/png",
      });
      await answerInputs([[composerInput(page), ""]]);
    }
  });
}

test("General's research and recurring starters follow its live feature switches", async ({
  page,
  userId,
}, testInfo) => {
  await openApplication(page, userId);
  await expect(sem(page, "starter-research")).toBeVisible();
  await expect(sem(page, "starter-recurring")).toBeVisible();
  for (const [title, id] of [
    ["Web", "research"],
    ["Routines", "recurring"],
  ]) {
    for (const enabled of [false, true]) {
      // The Bot's Plugins are two levels under its page: the gear, then the
      // Plugins row. The conversation is a column beside all of it.
      await openBotSettings(page);
      await press(sem(page, "bot-settings-plugins"));
      const toggle = page
        .getByRole("switch", { name: title, exact: true })
        .first();
      await expect(toggle).toBeVisible();
      await page.waitForTimeout(700);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
      await openBotPage(page);
      if (enabled) await expect(sem(page, `starter-${id}`)).toBeVisible();
      else await expect(sem(page, `starter-${id}`)).toHaveCount(0);
      await expect(sem(page, "starter-project")).toBeVisible();
      await expect(sem(page, "starter-specialist")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`${id}-${enabled ? "on" : "off"}.png`),
      });
      await testInfo.attach(`${id}-${enabled ? "on" : "off"}.png`, {
        path: testInfo.outputPath(`${id}-${enabled ? "on" : "off"}.png`),
        contentType: "image/png",
      });
    }
  }
});

test("racing account reads make one General and deleting it survives re-entry", async ({
  page,
  userId,
}, testInfo) => {
  const headers = { "x-frockbot-user-id": userId };
  const read = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const answers = await Promise.all(
    Array.from({ length: 8 }, () => read("/api/bots/bootstrap")),
  );
  const { generalBotId } = answers[0];
  expect(generalBotId).toMatch(/^general-[0-9a-f]{16}$/);
  expect(answers.every((answer) => answer.generalBotId === generalBotId)).toBe(
    true,
  );
  const before = await read("/api/bots");
  expect(before.bots).toHaveLength(1);
  expect(before.bots[0]).toMatchObject({
    botId: generalBotId,
    initialName: "General",
  });
  await openApplication(page, userId);
  await expect(sem(page, "starter-project")).toBeVisible();
  // Re-entry from a fresh client must also honor the account's deletion marker.
  await page.evaluate(() => localStorage.clear());
  await page.goto("about:blank");
  const impact = await read(`/api/bots/${generalBotId}/applets/impact`);
  const response = await page.request.post(
    `/api/bots/${generalBotId}/lifecycle`,
    {
      headers,
      data: {
        schemaVersion: 1,
        type: "bot/delete",
        botId: generalBotId,
        commandId: crypto.randomUUID(),
        appletImpact: impact.fingerprint,
      },
    },
  );
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ status: "applied" });
  await openApplication(page, userId);
  const after = await read("/api/bots");
  const bootstrap = await read("/api/bots/bootstrap");
  expect(after.bots).toEqual([]);
  expect(bootstrap.generalBotId).toBeNull();
  await expect(sem(page, "starter-suggestions")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("general-deleted.png") });
  await testInfo.attach("general-deleted.png", {
    path: testInfo.outputPath("general-deleted.png"),
    contentType: "image/png",
  });
  await testInfo.attach("bootstrap-and-deletion.json", {
    body: JSON.stringify(
      { answers, before, receipt, after, bootstrap },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("a Profile page opened during first load stays above General", async ({
  page,
  userId,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/bots$/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await openApplication(page, userId);
    await sem(page, "sidebar-profile").click();
    await expect(sem(page, "profile-sign-out")).toBeVisible();
    const loaded = page.waitForResponse(/\/api\/bots$/);
    release();
    await loaded;
    await expect
      .poll(() =>
        page.evaluate(
          (id) => localStorage.getItem(`frockbot.native.v1.directory/${id}`),
          userId,
        ),
      )
      .not.toBeNull();
    await expect(sem(page, "profile-sign-out")).toBeVisible();
    await expect(sem(page, "starter-suggestions")).toHaveCount(0);
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`frockbot.native.v1.selection.${id}`),
        userId,
      ),
    ).toBeNull();
    await page.screenshot({
      path: testInfo.outputPath("profile-before-general.png"),
    });
    await testInfo.attach("profile-before-general.png", {
      path: testInfo.outputPath("profile-before-general.png"),
      contentType: "image/png",
    });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
