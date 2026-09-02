import { describe, expect, it } from "bun:test";
import {
  BundleDecodeError,
  decodeBundleRequestV1,
  findUnresolvedSpecifier,
  type BundleRequestV1,
} from "./contracts.ts";

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    effectId: "effect-1",
    target: "bot-isolate",
    compatibilityDate: "2026-08-27",
    entry: "package.ts",
    sources: [{ path: "package.ts", text: "export const a = 1;\n" }],
    ...overrides,
  };
}

describe("decodeBundleRequestV1", () => {
  it("accepts an exact v1 request", () => {
    const decoded = decodeBundleRequestV1(request());
    expect(decoded satisfies BundleRequestV1).toEqual({
      schemaVersion: 1,
      effectId: "effect-1",
      target: "bot-isolate",
      compatibilityDate: "2026-08-27",
      entry: "package.ts",
      sources: [{ path: "package.ts", text: "export const a = 1;\n" }],
    });
  });

  it("accepts exactly one optional raw ui.html page", () => {
    expect(
      decodeBundleRequestV1(
        request({ ui: { path: "ui.html", html: "<!doctype html>" } }),
      ).ui,
    ).toEqual({ path: "ui.html", html: "<!doctype html>" });
    expect(() =>
      decodeBundleRequestV1(
        request({ ui: { path: "page.html", html: "<!doctype html>" } }),
      ),
    ).toThrow("ui must contain one non-empty ui.html");
  });

  it("rejects an unknown field", () => {
    expect(() =>
      decodeBundleRequestV1(
        request({ registry: "https://registry.npmjs.org" }),
      ),
    ).toThrow(BundleDecodeError);
  });

  it("rejects a missing field", () => {
    const value = request() as Record<string, unknown>;
    delete value.compatibilityDate;
    expect(() => decodeBundleRequestV1(value)).toThrow(BundleDecodeError);
  });

  it("rejects a schemaVersion other than 1", () => {
    expect(() => decodeBundleRequestV1(request({ schemaVersion: 2 }))).toThrow(
      "unsupported bundle request",
    );
  });

  it("rejects a target other than bot-isolate", () => {
    expect(() => decodeBundleRequestV1(request({ target: "gateway" }))).toThrow(
      "target is invalid",
    );
  });

  it("rejects an entry other than package.ts", () => {
    expect(() => decodeBundleRequestV1(request({ entry: "index.ts" }))).toThrow(
      "entry is invalid",
    );
  });

  it("rejects an invalid compatibilityDate", () => {
    expect(() =>
      decodeBundleRequestV1(request({ compatibilityDate: "yesterday" })),
    ).toThrow("compatibilityDate is invalid");
  });

  it("rejects an empty or non-string effectId", () => {
    expect(() => decodeBundleRequestV1(request({ effectId: "" }))).toThrow(
      "effectId is invalid",
    );
    expect(() => decodeBundleRequestV1(request({ effectId: 7 }))).toThrow(
      "effectId is invalid",
    );
  });

  it("rejects zero, two, or non-array sources", () => {
    expect(() => decodeBundleRequestV1(request({ sources: [] }))).toThrow(
      "exactly one source file is required",
    );
    expect(() =>
      decodeBundleRequestV1(
        request({
          sources: [
            { path: "package.ts", text: "export const a = 1;\n" },
            { path: "package.json", text: "{}" },
          ],
        }),
      ),
    ).toThrow("exactly one source file is required");
    expect(() => decodeBundleRequestV1(request({ sources: {} }))).toThrow(
      BundleDecodeError,
    );
  });

  it("rejects a package.json as the only source", () => {
    expect(() =>
      decodeBundleRequestV1(
        request({ sources: [{ path: "package.json", text: "{}" }] }),
      ),
    ).toThrow('source path must be "package.ts"');
  });

  it("rejects an unknown field inside a source", () => {
    expect(() =>
      decodeBundleRequestV1(
        request({
          sources: [{ path: "package.ts", text: "1;\n", loader: "ts" }],
        }),
      ),
    ).toThrow(BundleDecodeError);
  });

  it("rejects a non-object request", () => {
    expect(() => decodeBundleRequestV1(null)).toThrow(BundleDecodeError);
    expect(() => decodeBundleRequestV1([request()])).toThrow(BundleDecodeError);
    expect(() => decodeBundleRequestV1("{}")).toThrow(BundleDecodeError);
  });
});

describe("findUnresolvedSpecifier", () => {
  it("passes a fully inlined module", () => {
    expect(
      findUnresolvedSpecifier(
        'var a = 1;\nexport { a };\nconst text = "import from nowhere";\n',
      ),
    ).toBeUndefined();
  });

  it("allows cloudflare: built-ins, which are always external", () => {
    expect(
      findUnresolvedSpecifier('import { env } from "cloudflare:workers";\n'),
    ).toBeUndefined();
  });

  it("finds a surviving bare specifier", () => {
    expect(findUnresolvedSpecifier('import { z } from "zod";\n')).toBe("zod");
    expect(findUnresolvedSpecifier('import "node:fs";\n')).toBe("node:fs");
    expect(findUnresolvedSpecifier('const fs = require("node:fs");\n')).toBe(
      "node:fs",
    );
    expect(findUnresolvedSpecifier('await import("zod");\n')).toBe("zod");
  });

  it("finds a surviving relative specifier: this slice bundles one file", () => {
    expect(findUnresolvedSpecifier('import { h } from "./helper";\n')).toBe(
      "./helper",
    );
  });

  it("does not flag esbuild's own __require helper or Array.from", () => {
    expect(
      findUnresolvedSpecifier(
        'var x = __require("thing");\nvar y = Array.from("abc");\n',
      ),
    ).toBeUndefined();
  });
});
