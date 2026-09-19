import { describe, expect, test } from "bun:test";
import { indexPackageCatalogV1 } from "./package-catalog.js";

describe("Package catalog index", () => {
  test("resolves the one deployed Package and its exact version", () => {
    const catalog = indexPackageCatalogV1(
      [
        { packageId: "web", version: "1.0.0" },
        { packageId: "search", version: "2.0.0" },
      ],
      ({ packageId, version }) => ({ packageId, version }),
    );

    expect(catalog.entries.map(({ packageId }) => packageId)).toEqual([
      "web",
      "search",
    ]);
    expect(catalog.get("web")).toEqual({
      packageId: "web",
      version: "1.0.0",
    });
    expect(catalog.has("web", "1.0.0")).toBe(true);
    expect(catalog.has("web", "2.0.0")).toBe(false);
    expect(catalog.get("missing")).toBeUndefined();
  });

  test("rejects duplicate Package ids even when their versions differ", () => {
    expect(() =>
      indexPackageCatalogV1(
        [
          { packageId: "web", version: "1.0.0" },
          { packageId: "web", version: "2.0.0" },
        ],
        ({ packageId, version }) => ({ packageId, version }),
      ),
    ).toThrow('duplicate Package id "web"');
  });
});
