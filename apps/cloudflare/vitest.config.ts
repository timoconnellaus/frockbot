import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

function readDevVariable(name: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(resolve(import.meta.dirname, ".dev.vars"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

const runLiveSpriteTest = process.env.FROCKBOT_RUN_LIVE_SPRITE_TEST === "1";
const spritesToken = runLiveSpriteTest
  ? (process.env.SPRITES_TOKEN ?? readDevVariable("SPRITES_TOKEN") ?? "")
  : "";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/fly-compatibility-worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          FLY_COMPATIBILITY: "FlyCompatibilityProbe",
        },
        bindings: {
          FROCKBOT_RUN_LIVE_SPRITE_TEST: runLiveSpriteTest ? "1" : "0",
          SPRITES_TOKEN: spritesToken,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 15 * 60_000,
  },
});
