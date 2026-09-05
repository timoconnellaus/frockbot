// The Applet rules of `AGENTS.md`, enforced where they are source-graph facts.
//
// The behavioural half — facet storage surviving a generation change and a
// revert, a failed health check leaving the prior facet resident, delete
// removing storage, versions, and entry, and the viewer token's scope — runs
// against the real Durable Object in workerd:
// `apps/cloudflare/test/applets.workerd.ts`. What is checked here is what only
// the source can answer: that a facet exists nowhere but under the Applet
// Durable Object, that an Applet's page carries no credential but its token,
// and that the kernel's Applet records name no Package.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function sourceFiles(...patterns: string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    files.push(
      ...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true }),
    );
  }
  return files
    .filter((path) => !path.includes("node_modules/"))
    .filter((path) => !path.includes("/dist/"))
    .sort();
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("Applet boundaries", () => {
  // Constitution — Package composition: "Composition Packages never own
  // storage; facets exist only under the Applet Durable Object."
  test("only the Applet Durable Object mounts a facet", () => {
    const allowed = new Set([
      "apps/cloudflare/src/applet-state.ts",
      // That object's own proof. It reaches the facet surface only through
      // `runInDurableObject` on the Applet Durable Object itself — to snapshot
      // and instrument what the object does — and mounts nothing of its own.
      "apps/cloudflare/test/applets.workerd.ts",
      // The lane S1 spike, deliberately kept out of `test:workerd`.
      "apps/cloudflare/test/spike-applet-facet-worker.ts",
      // This vendored reference host is deliberately outside the product
      // dependency graph; the adjacent check keeps the exception inert.
      "packages/compose-cloudflare/src/host.ts",
    ]);
    const offenders: string[] = [];
    for (const path of sourceFiles(
      "packages/**/src/**/*.ts",
      "apps/*/src/**/*.ts",
      "apps/*/test/**/*.ts",
      "applications/*/src/**/*.ts",
    )) {
      if (allowed.has(path)) continue;
      const source = read(path);
      if (/\bctx\.facets\.|\bstate\.facets\.|\bfacets\.get\(/.test(source)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the vendored Compose host stays outside the product dependency graph", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(
      "package.json",
      "packages/*/package.json",
      "apps/*/package.json",
      "applications/*/package.json",
    )) {
      if (path.startsWith("packages/compose-")) continue;
      const manifest = JSON.parse(read(path)) as Record<string, unknown>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const dependencies = manifest[field];
        if (!dependencies || typeof dependencies !== "object") continue;
        if (
          Object.keys(dependencies).some((name) =>
            name.startsWith("@frockbot/compose-"),
          )
        ) {
          offenders.push(`${path}:${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Constitution — Package composition: the kernel "mounts the instance's
  // server artifact ... through Worker Loader with `globalOutbound` disabled".
  test("the Applet loader mounts with no egress and a two-key env", () => {
    const source = read("apps/cloudflare/src/applet-state.ts");
    expect(source).toContain("globalOutbound: null");
    // Exactly `IDENTITY` and `CAPABILITIES`, and nothing else, is placed in the
    // loaded worker's env. The workerd test asserts the same from inside.
    const env = source.slice(source.indexOf("env: {"));
    expect(env).toContain("IDENTITY:");
    expect(env).toContain("CAPABILITIES:");
    for (const forbidden of [
      "APPLICATION_ARTIFACTS:",
      "APPLET_STATES:",
      "APPLETS:",
      "SECRET_TOKEN",
    ]) {
      expect(env.slice(0, env.indexOf("limits:")).includes(forbidden)).toBe(
        false,
      );
    }
  });

  // Spike finding 1 (`docs/research/spike-applet-facets.md` §7): a loader id is
  // served from cache with the `env` it was first loaded with, process-wide, so
  // two Applets of one User with identical code would otherwise share one
  // IDENTITY and one CAPABILITIES stub.
  test("the Applet loader id includes the Applet instance", () => {
    const source = read("packages/kernel-do/src/applets.ts");
    const start = source.indexOf("export function appletLoaderIdV1");
    const digest = source.indexOf("JSON.stringify({", start);
    const body = source.slice(digest, source.indexOf("})", digest));
    for (const input of [
      "contract",
      "appletId",
      "serverHash",
      "bindingDigest",
    ]) {
      expect(body).toContain(`${input}: input.${input}`);
    }
  });

  // Spike finding 2 (§5b): `ctx.storage.setAlarm` inside a facet throws, and the
  // throw is not catchable by the Applet, so the kernel object owns the alarm.
  test("the Applet capability surface is the alarm and the model, and nothing else", () => {
    const source = read("apps/cloudflare/src/applet-state.ts");
    const capabilities = source.slice(
      source.indexOf("export class AppletCapabilities"),
      source.indexOf("export class AppletState"),
    );
    const methods = [
      ...capabilities.matchAll(/^ {2}(?:async )?([a-zA-Z]+)\(/gmu),
    ].map((match) => match[1]);
    expect(methods.toSorted()).toEqual(["invokeModel", "scheduleAlarm"]);
  });

  // Spike finding 4 (§8): "Stubs pointing to Durable Object facets are not
  // serializable" — the kernel object forwards, and never hands the stub out.
  test("no facet stub is returned across an RPC boundary", () => {
    const source = read("apps/cloudflare/src/applet-state.ts");
    // `#facet` is private, and every public method that uses it consumes it in
    // place. A public method returning it would have to name it in a return.
    expect(/return\s+(await\s+)?this\.#facet\(/.test(source)).toBe(false);
  });

  // Constitution — Architecture checks: "an open Applet's page carries no
  // credential and reaches its facet only through a short-lived viewer token
  // scoped to that Applet and User."
  test("the viewer token is HMAC-signed, scoped, and short-lived", () => {
    const source = read("packages/kernel-do/src/applets.ts");
    expect(source).toContain('name: "HMAC", hash: "SHA-256"');
    expect(source).toContain("APPLET_VIEWER_TOKEN_TTL_MS = 15 * 60_000");
    // The claims are exactly the scope: User, Applet, generation, expiry.
    const minted = source.slice(
      source.indexOf("export async function mintAppletViewerTokenV1"),
    );
    const payload = minted.slice(
      minted.indexOf("JSON.stringify({"),
      minted.indexOf("}),"),
    );
    expect(payload).toContain("u: claims.u");
    expect(payload).toContain("a: claims.a");
    expect(payload).toContain("g: claims.g");
    expect(payload).toContain("exp: claims.exp");
    // Constant-time comparison: the signature check is the whole of the door.
    expect(source).toContain("constantTimeEqualsV1(presented, expected)");
  });

  test("the socket route compares the token's Applet against the path", () => {
    const source = read("apps/cloudflare/src/gateway.ts");
    expect(source).toContain("if (claims.a !== appletId)");
    // The token never travels on to the Durable Object; the verified claims do.
    expect(source).toContain('forwarded.searchParams.delete("token")');
  });

  // Constitution — Minimal kernel: "The kernel imports no Package."
  test("the kernel's Applet records import no Package", () => {
    const source = read("packages/kernel-do/src/applets.ts");
    expect(/from "@frockbot\/plugin-/.test(source)).toBe(false);
    // The Applets Package's root ids are declared, not imported, and the TODO
    // says why and names the lane that removes the duplication.
    expect(source).toContain("TODO(lane C1)");
  });

  // ADR 0022 decision 4: an Applet's tools are Composition members, so an
  // admitted Turn records the Applet generation it ran under.
  test("Applet members are covered by the artifact set hash", () => {
    const source = read("packages/kernel-composition/src/generation.ts");
    const hash = source.slice(
      source.indexOf("export function compositionArtifactSetHashV1"),
    );
    expect(hash.slice(0, hash.indexOf("\n}"))).toContain("applets");
    // And a Bot cannot author, install, or remove one directly: no origin kind
    // names an Applet.
    expect(source).not.toContain('kind: "applet-install"');
  });
});
