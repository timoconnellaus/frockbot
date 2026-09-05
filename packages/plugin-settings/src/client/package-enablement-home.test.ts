import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";

/**
 * Package enablement has one home.
 *
 * "The Plugins surface installs, uninstalls, enables, and disables Packages"
 * (AGENTS.md, "Settings surfaces"), and every control has exactly one home.
 * Models grew a second one — a "Turn on Custom models" button that ran the
 * same command — so the same decision could be made in two places. A second
 * home is easy to add by accident and invisible in review, so it is checked
 * here rather than remembered.
 */
const directory = new URL("./", import.meta.url);
const surfaces = readdirSync(directory).filter((name) => name.endsWith(".vue"));

test("only Plugins turns a Package on or off", async () => {
  const callers: string[] = [];
  for (const name of surfaces) {
    const source = await Bun.file(new URL(name, directory)).text();
    if (source.includes("setPackageEnabled")) callers.push(name);
  }
  expect(callers).toEqual(["PluginsSurface.vue"]);
});

test("Models sends the decision to Plugins instead of making it", async () => {
  const source = await Bun.file(new URL("ModelsSurface.vue", directory)).text();
  expect(source).toContain(`surfaces.open("plugins")`);
  expect(source).not.toContain("setPackageEnabled");
});
