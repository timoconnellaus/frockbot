import { expect, test } from "bun:test";
import {
  OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY,
  cleanRetiredOllamaWebSearchV1,
  withoutRetiredWebSearchSettingV1,
} from "./ollama-web-search-cleanup.js";

function fixture(entries: [string, unknown][] = []) {
  const values = new Map(entries);
  const tx = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
  };
  const storage = {
    async get(key: string) {
      return values.get(key);
    },
    async transaction(body: (storage: unknown) => Promise<void>) {
      await body(tx);
    },
  } as unknown as DurableObjectStorage;
  return { values, storage };
}

const settings = (packages: unknown[]) => ({
  schemaVersion: 1,
  revision: 12,
  profile: {},
  packages,
  connections: [],
});

test("drops the retired value and the bag it emptied, and nothing else", () => {
  expect(
    withoutRetiredWebSearchSettingV1(
      settings([
        { packageId: "web", version: "0.0.1", state: "installed" },
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
          values: { "web-search-max-results": 4 },
        },
        {
          packageId: "image",
          version: "0.0.1",
          state: "installed",
          values: { model: "@cf/black-forest-labs/flux-1-schnell" },
        },
      ]),
    ),
  ).toEqual(
    settings([
      { packageId: "web", version: "0.0.1", state: "installed" },
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "installed",
      },
      {
        packageId: "image",
        version: "0.0.1",
        state: "installed",
        values: { model: "@cf/black-forest-labs/flux-1-schnell" },
      },
    ]),
  );
  expect(
    withoutRetiredWebSearchSettingV1(
      settings([
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
          values: { "web-search-max-results": 4, other: "kept" },
        },
      ]),
    ),
  ).toEqual(
    settings([
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "installed",
        values: { other: "kept" },
      },
    ]),
  );
});

test("leaves settings with nothing retired alone", () => {
  expect(
    withoutRetiredWebSearchSettingV1(
      settings([
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ]),
    ),
  ).toBeUndefined();
  expect(withoutRetiredWebSearchSettingV1(undefined)).toBeUndefined();
  expect(
    withoutRetiredWebSearchSettingV1({ schemaVersion: 1 }),
  ).toBeUndefined();
});

test("constructor cleanup rewrites the record once and receipts it", async () => {
  const stored = settings([
    {
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
      state: "installed",
      values: { "web-search-max-results": 2 },
    },
  ]);
  const { values, storage } = fixture([["user-configuration", stored]]);

  await cleanRetiredOllamaWebSearchV1(
    storage,
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(values.get("user-configuration")).toEqual(
    settings([
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        state: "installed",
      },
    ]),
  );
  expect(values.get(OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY)).toEqual({
    at: "2026-09-24T00:00:00.000Z",
    removed: true,
  });

  // A second load reads the receipt and touches nothing, even a value that
  // somehow came back.
  values.set("user-configuration", stored);
  await cleanRetiredOllamaWebSearchV1(storage);
  expect(values.get("user-configuration")).toEqual(stored);
});

test("an account with nothing stored is receipted and left empty", async () => {
  const { values, storage } = fixture();
  await cleanRetiredOllamaWebSearchV1(
    storage,
    new Date("2026-09-24T00:00:00.000Z"),
  );
  expect(values.has("user-configuration")).toBe(false);
  expect(values.get(OLLAMA_WEB_SEARCH_CLEANUP_RECEIPT_KEY)).toEqual({
    at: "2026-09-24T00:00:00.000Z",
    removed: false,
  });
});
