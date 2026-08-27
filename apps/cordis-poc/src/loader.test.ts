import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Loader from "@cordisjs/plugin-loader";
import { Context } from "cordis";

interface LoaderFixtureState {
  setups: string[];
  cleanups: string[];
}

declare global {
  // Shared deliberately with the dynamically imported fixture module.
  // eslint-disable-next-line no-var
  var __frockbotLoaderFixture: LoaderFixtureState;
}

let root: Context;

async function eventually(
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw latestError;
}

beforeEach(async () => {
  globalThis.__frockbotLoaderFixture = { setups: [], cleanups: [] };
  root = new Context();
  await root.plugin(Loader, { baseUrl: new URL("./", import.meta.url).href });
});

afterEach(async () => {
  await root.fiber.dispose();
});

describe("pinned Cordis loader", () => {
  test("creates, updates, and removes one ESM plugin", async () => {
    const id = await root.loader.create({
      name: "./fixtures/loader-plugin.mjs",
      config: { label: "one" },
    });
    await root.loader.await();
    expect(globalThis.__frockbotLoaderFixture.setups).toEqual(["one"]);

    await root.loader.update(id, { config: { label: "two" } });
    await root.loader.resolve(id).fiber?.await();
    expect(globalThis.__frockbotLoaderFixture.setups).toEqual(["one", "two"]);
    await eventually(() =>
      expect(globalThis.__frockbotLoaderFixture.cleanups).toEqual(["one"]),
    );

    root.loader.remove(id);
    await root.loader.await();
    await eventually(() =>
      expect(globalThis.__frockbotLoaderFixture.cleanups).toEqual([
        "one",
        "two",
      ]),
    );
  });

  test("contains a failing dynamic import without mounting a fiber", async () => {
    const id = await root.loader.create({
      name: "./fixtures/does-not-exist.mjs",
    });
    await root.loader.await();
    expect(root.loader.resolve(id).fiber).toBeUndefined();
  });
});
