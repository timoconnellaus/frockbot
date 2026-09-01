import { expect, openApplication, test } from "./fixtures.ts";

function channels(color: string): [number, number, number] {
  const match = color.match(
    /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/,
  );
  if (!match) throw new Error(`Expected an RGB color, received ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

test("uses dark product surfaces with the FrockBot pink action", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  await expect(page.getByRole("dialog")).toBeVisible();

  const colors = await page.evaluate(() => {
    const background = (selector: string): string => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Theme surface ${selector} was not rendered`);
      }
      return getComputedStyle(element).backgroundColor;
    };

    return {
      body: getComputedStyle(document.body).backgroundColor,
      sidebar: background(".sidebar"),
      thread: background(".thread"),
      primary: background(".flock-actions .primary"),
    };
  });

  for (const [surface, color] of Object.entries(colors).filter(
    ([name]) => name !== "primary",
  )) {
    expect(
      luminance(color),
      `${surface} should remain a dark product surface (${color})`,
    ).toBeLessThan(0.2);
  }
  expect(channels(colors.primary)).toEqual([236, 56, 107]);
});
