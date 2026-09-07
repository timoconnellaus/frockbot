/**
 * The building view, as the two surfaces that draw it are written.
 *
 * Bun has no single-file-component loader, so a `.vue` file is read as text
 * here — the same thing `ComputerCard.test.ts` does. It proves the wiring the
 * unit tests for the projection cannot: that the panel and the phone chip both
 * read the one projection, and that neither still shows the fixed line it used
 * to show for the whole of a build.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "@vue/compiler-sfc";

const canvas = await Bun.file(
  new URL("./AppletCanvas.vue", import.meta.url),
).text();
const app = await Bun.file(
  new URL("./FrockBotApp.vue", import.meta.url),
).text();
const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text();

describe("the Applet canvas while the Bot is still building", () => {
  test("the file parses as a single-file component", () => {
    expect(parse(canvas).errors).toEqual([]);
  });

  test("the panel draws the projection rather than a fixed line", () => {
    expect(canvas).toContain('from "./applet-progress.js"');
    expect(canvas).toContain('data-testid="applet-canvas-progress"');
    expect(canvas).toContain("progress.label");
    expect(canvas).toContain("progress.failure");
    expect(canvas).toContain("progress.output");
    // The line the panel used to show for minutes on end, whatever happened.
    expect(canvas).not.toContain("Not published yet");
  });

  test("the progress block is announced and is gone once the Applet runs", () => {
    expect(canvas).toContain('role="status"');
    expect(canvas).toContain(
      'v-if="applet && !loading && progress && beingBuilt"',
    );
  });

  test("the build output is monospace and cannot grow without bound", () => {
    expect(canvas).toContain("font-family: var(--frock-font-mono);");
    expect(canvas).toContain("max-height: 180px;");
  });

  test("the working dot stops moving where motion is not wanted", () => {
    expect(canvas).toContain("@media (prefers-reduced-motion: reduce)");
    expect(canvas).toContain(
      ".applet-canvas-progress-dot {\n    animation: none;",
    );
  });
});

describe("the phone's way in", () => {
  test("the chip carries the same line and opens the same panel", () => {
    expect(app).toContain('from "./applet-progress.js"');
    expect(app).toContain("appletChipStatus");
    // The one overlay: the right panel drawer, opened by the one toggle.
    expect(app).toContain('class="applet-chip"');
    expect(app).toContain('@click="toggleRightPanel"');
  });

  test("the chip has room for a second line", () => {
    expect(styles).toContain(".applet-chip-status {");
    expect(styles).toContain("min-height: var(--frock-control-md);");
  });
});
