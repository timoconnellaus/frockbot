// The theme, read off the screen.
//
// The client paints to a canvas, so there is no computed style to ask: a
// surface's colour exists only as pixels. What this can still prove is what
// the old spec proved — that the product's own surfaces are dark and that the
// action carries the FrockBot pink — and it proves it the only way left, by
// sampling the picture the browser drew. What it cannot say is *why* a pixel
// is that colour, so every sample is taken at a point inside a named widget
// that holds no content, and nothing is asserted about anything between them.
import { expect, field, openApplication, sem, test } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The one colour the product is named after. */
const FROCKBOT_PINK: [number, number, number] = [236, 56, 107];

type Colour = [number, number, number];

/**
 * The colour of the screen at each named point.
 *
 * The screenshot is decoded in the page rather than in Node: there is no PNG
 * decoder among this repository's dependencies, and the browser has one.
 * Drawing it to a detached canvas touches nothing Flutter owns.
 */
async function coloursAt(
  page: Page,
  points: Record<string, { x: number; y: number }>,
): Promise<Record<string, Colour>> {
  // Handed over as plain bytes: the PNG is decoded by the browser's own
  // decoder, which is the only one this repository has.
  const shot = Array.from(await page.screenshot());
  return page.evaluate(
    async ({ shot, points }) => {
      const image = await createImageBitmap(
        new Blob([new Uint8Array(shot)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context to decode the screenshot");
      context.drawImage(image, 0, 0);
      // The screenshot is in device pixels and the boxes are in CSS pixels.
      const scale = image.width / window.innerWidth;
      const sampled: Record<string, [number, number, number]> = {};
      for (const [name, point] of Object.entries(points)) {
        const data = context.getImageData(
          Math.round(point.x * scale),
          Math.round(point.y * scale),
          1,
          1,
        ).data;
        sampled[name] = [data[0]!, data[1]!, data[2]!];
      }
      return sampled;
    },
    { shot, points },
  );
}

/** Perceived brightness, on the same curve the old spec used. */
function luminance([red, green, blue]: Colour): number {
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

test("uses dark product surfaces with the FrockBot pink action", async ({
  page,
  userId,
}) => {
  await openApplication(page, userId);
  const sidebar = await sem(page, "shell-sidebar").boundingBox();
  const conversation = await sem(page, "shell-conversation").boundingBox();
  expect(sidebar, "the Bot list has no box").not.toBeNull();
  expect(conversation, "the conversation has no box").not.toBeNull();
  if (!sidebar || !conversation) return;

  // Both points are in a column's own gutter, a few pixels inside its edge and
  // well below its header: the surface, with nothing drawn on it.
  const surfaces = await coloursAt(page, {
    sidebar: {
      x: Math.round(sidebar.x + 6),
      y: Math.round(sidebar.y + sidebar.height * 0.6),
    },
    conversation: {
      x: Math.round(conversation.x + conversation.width - 6),
      y: Math.round(conversation.y + conversation.height * 0.8),
    },
  });
  for (const [name, colour] of Object.entries(surfaces)) {
    expect(
      luminance(colour),
      `${name} should remain a dark product surface (${colour})`,
    ).toBeLessThan(0.2);
  }

  // The create sheet is where an unprovisioned account can reach a primary
  // action at all: the composer's Send is drawn disabled until a Bot and a
  // model exist, and a disabled button is grey by design.
  await sem(page, "sidebar-create-bot").click();
  await expect(sem(page, "flock-create")).toBeVisible();
  await field(page, "flock-create-name").fill("Swatch");
  const submit = await sem(page, "flock-create-submit").boundingBox();
  expect(submit, "the create action has no box").not.toBeNull();
  if (!submit) return;
  // Inside the button's fill and clear of its label, which is centred.
  const action = await coloursAt(page, {
    action: {
      x: Math.round(submit.x + 6),
      y: Math.round(submit.y + submit.height / 2),
    },
  });
  expect(action.action).toEqual(FROCKBOT_PINK);
});
