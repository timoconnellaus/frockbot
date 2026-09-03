/**
 * The bundler seam under workerd, driven through the service binding the Bot
 * Durable Object will use (`SELF` is the `PackageBundler` entrypoint).
 */
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import type { BundleRequestV1, BundleResultV1 } from "../src/contracts.ts";
import { bundleRequest, FIXTURE_TOOL_TS } from "./fixtures.ts";

/**
 * `SELF` in `@cloudflare/vitest-plugin@1.1.2` is a loopback stub whose RPC
 * methods cannot be reached from the test runner, so these tests drive the
 * `PackageBundler` entrypoint through its `fetch` shim. The shim calls the same
 * `bundlePackage` seam as the `bundle()` RPC method the `PACKAGE_BUNDLER`
 * binding exposes, over the same JSON-shaped payload.
 */
async function bundle(request: BundleRequestV1): Promise<BundleResultV1> {
  const response = await SELF.fetch("https://bundler.invalid/", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return (await response.json()) as BundleResultV1;
}

it("bundles TypeScript features: enum, satisfies, generics, top-level await", async () => {
  const result = await bundle(bundleRequest());
  expect(result.status).toBe("bundled");
  if (result.status !== "bundled") return;
  expect(result.module).toContain("summarise");
  expect(result.module).not.toContain("satisfies");
  expect(result.module).toContain("await Promise.resolve(41)");
  expect(result.artifact.mediaType).toBe("application/javascript");
  expect(result.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(result.artifact.size).toBe(
    new TextEncoder().encode(result.module).byteLength,
  );
  expect(result.artifact.bundlerVersion).toBe(
    "@cloudflare/worker-bundler@0.2.3",
  );
});

it("is deterministic: two calls produce the same contentHash", async () => {
  const first = await bundle(bundleRequest({ effectId: "effect-a" }));
  const second = await bundle(bundleRequest({ effectId: "effect-b" }));
  expect(first.status).toBe("bundled");
  expect(second.status).toBe("bundled");
  if (first.status !== "bundled" || second.status !== "bundled") return;
  expect(second.artifact.contentHash).toBe(first.artifact.contentHash);
  expect(second.artifact.size).toBe(first.artifact.size);
  expect(second.module).toBe(first.module);
  expect(second.effectId).toBe("effect-b");
});

it("reports the sha-256 of the module bytes it returns", async () => {
  const result = await bundle(bundleRequest());
  expect(result.status).toBe("bundled");
  if (result.status !== "bundled") return;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(result.module),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  expect(result.artifact.contentHash).toBe(hex);
});

it("returns every raw UI page under its own content hash", async () => {
  const main = "<!doctype html><script>window.frockbot.resize()</script>";
  const board = "<!doctype html><h1>Board</h1>";
  const result = await bundle(
    bundleRequest({
      uiPages: [
        { id: "main", html: main },
        { id: "board", html: board },
      ],
    }),
  );
  expect(result.status).toBe("bundled");
  if (result.status !== "bundled") return;
  const hashOf = async (html: string) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  };
  expect(result.uiArtifacts).toEqual([
    {
      id: "main",
      artifact: {
        contentHash: await hashOf(main),
        size: new TextEncoder().encode(main).byteLength,
        mediaType: "text/html",
        bundlerVersion: "frockbot-inline-html@1",
      },
      html: main,
    },
    {
      id: "board",
      artifact: {
        contentHash: await hashOf(board),
        size: new TextEncoder().encode(board).byteLength,
        mediaType: "text/html",
        bundlerVersion: "frockbot-inline-html@1",
      },
      html: board,
    },
  ]);
});

it("refuses UI pages outside the id, count, and uniqueness bounds", async () => {
  for (const uiPages of [
    [],
    [{ id: "Main", html: "<!doctype html>" }],
    [
      { id: "main", html: "<!doctype html>" },
      { id: "main", html: "<!doctype html><b>2</b>" },
    ],
    Array.from({ length: 9 }, (_unused, index) => ({
      id: `page-${index}`,
      html: "<!doctype html>",
    })),
  ]) {
    const result = await bundle(bundleRequest({ uiPages }));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") continue;
    expect(result.failure).toBe("invalid-request");
  }
});

it("fails a syntax error with a file:line:col diagnostic and no artifact", async () => {
  const result = await bundle(
    bundleRequest({
      sources: [{ path: "package.ts", text: "export const broken = ;\n" }],
    }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure).toBe("bundle-failed");
  expect(result.diagnostics.join("\n")).toMatch(/package\.ts:\d+:\d+/);
  expect(result).not.toHaveProperty("artifact");
});

it("rejects a package.json in sources — Bot text must never drive an npm fetch", async () => {
  const result = await bundle(
    bundleRequest({
      sources: [
        { path: "package.ts", text: FIXTURE_TOOL_TS },
        {
          path: "package.json",
          text: JSON.stringify({ dependencies: { zod: "3.25.76" } }),
        },
      ],
    }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure).toBe("invalid-request");
});

it("fails a bare specifier import rather than reporting success", async () => {
  const result = await bundle(
    bundleRequest({
      sources: [
        {
          path: "package.ts",
          text: 'import { z } from "zod";\nexport const schema = z.string();\n',
        },
      ],
    }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(["unresolved-import", "bundle-failed"]).toContain(result.failure);
  expect(result.diagnostics.join("\n")).toContain("zod");
});

it("fails a relative sibling import: this slice accepts a single file", async () => {
  const result = await bundle(
    bundleRequest({
      sources: [
        {
          path: "package.ts",
          text: 'import { helper } from "./helper";\nexport const value = helper();\n',
        },
      ],
    }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(["unresolved-import", "bundle-failed"]).toContain(result.failure);
});

it("refuses source over the 256 KB quota", async () => {
  const oversize = `${FIXTURE_TOOL_TS}\n// ${"x".repeat(256 * 1024)}\n`;
  const result = await bundle(
    bundleRequest({ sources: [{ path: "package.ts", text: oversize }] }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure).toBe("source-too-large");
});

it("refuses a UI page over the 256 KB quota", async () => {
  const result = await bundle(
    bundleRequest({
      uiPages: [{ id: "main", html: "x".repeat(256 * 1024 + 1) }],
    }),
  );
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure).toBe("ui-too-large");
});

it("rejects an unknown request field instead of throwing across the binding", async () => {
  const result = await bundle({
    ...bundleRequest(),
    registry: "https://registry.npmjs.org",
  } as unknown as BundleRequestV1);
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.failure).toBe("invalid-request");
  expect(result.effectId).toBe("effect-0001");
});

it("rejects a wrong target or entry", async () => {
  const wrongTarget = await bundle({
    ...bundleRequest(),
    target: "gateway",
  } as unknown as BundleRequestV1);
  const wrongEntry = await bundle({
    ...bundleRequest(),
    entry: "index.ts",
  } as unknown as BundleRequestV1);
  expect(wrongTarget.status).toBe("failed");
  expect(wrongEntry.status).toBe("failed");
});
