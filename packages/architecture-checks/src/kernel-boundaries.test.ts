// Constitutional checks that are pure source-graph facts: what the kernel may
// import, what a client bundle or protocol may carry, and what core runtime
// code may depend on. Each rule is one named test so `docs/architecture-checks.md`
// can point at it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function sourceFiles(...patterns: string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    files.push(
      ...new Bun.Glob(pattern).scanSync({
        cwd: repoRoot,
        onlyFiles: true,
      }),
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

describe("kernel boundaries", () => {
  // Constitution — Minimal kernel: "The kernel imports no Package and contains
  // no product policy."
  test("the kernel imports no Package", async () => {
    const check = Bun.spawnSync({
      cmd: ["bun", "scripts/check-kernel-imports.ts"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${check.stdout.toString()}${check.stderr.toString()}`;
    expect(output).toContain("Kernel import contract passed");
    expect(check.exitCode).toBe(0);
    await Promise.resolve();
  });

  // Constitution — Architecture checks: "two provider Packages satisfy the
  // model interface with no kernel diff". The behavioural half is in
  // model-interface.test.ts; this is the source half.
  test("no kernel source names a model provider Package", () => {
    const providerTerms = [
      "provider-foundation",
      "provider-ollama-cloud",
      "openai-compatible",
      "ollama.com",
    ];
    const offenders: string[] = [];
    for (const path of sourceFiles("packages/kernel-*/src/**/*.ts")) {
      if (path.endsWith(".test.ts")) continue;
      const source = read(path);
      for (const term of providerTerms) {
        if (source.includes(term)) offenders.push(`${path}: ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Constitution — Explicit seams: "Core and runtime modules are independent of
  // Electron and client-framework authority."
  test("core runtime code has no Electron dependency", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(
      "packages/kernel-*/src/**/*.ts",
      "packages/client-core/src/**/*.ts",
      "packages/configuration-core/src/**/*.ts",
      "packages/connection-core/src/**/*.ts",
      "packages/computer-core/src/**/*.ts",
      "packages/protocol/src/**/*.ts",
      "packages/plugin-shell/src/backend*.ts",
      "packages/plugin-settings/src/backend*.ts",
      "applications/foundation/src/runtime.ts",
      "applications/foundation/src/user.ts",
      "apps/cloudflare/src/**/*.ts",
    )) {
      if (/from\s+"electron(\/|")/.test(read(path))) offenders.push(path);
    }
    expect(offenders).toEqual([]);

    const manifests = [
      "packages/kernel-contracts",
      "packages/kernel-agent-loop",
      "packages/kernel-composition",
      "packages/kernel-do",
      "packages/client-core",
      "packages/protocol",
      "packages/plugin-shell",
      "applications/foundation",
      "apps/cloudflare",
    ];
    for (const manifest of manifests) {
      const declared = read(`${manifest}/package.json`);
      expect({ manifest, electron: declared.includes('"electron"') }).toEqual({
        manifest,
        electron: false,
      });
    }
  });

  // Constitution — Plugin-owned integrations: "Secrets remain server-side and
  // cross interfaces only as opaque references when necessary."
  test("client bundles and protocols contain no secrets", () => {
    const secretNames = [
      "CREDENTIAL_KEYRING",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "SPRITES_TOKEN",
      "OLLAMA_API_KEY",
    ];
    const offenders: string[] = [];
    for (const path of sourceFiles(
      "packages/*/src/client/**/*.{ts,vue}",
      "packages/client-core/src/**/*.ts",
      "packages/client-ui/src/**/*.{ts,vue}",
      "packages/protocol/src/**/*.ts",
      "packages/webui-shell/src/**/*.{ts,vue}",
    )) {
      if (path.endsWith(".test.ts")) continue;
      const source = read(path);
      for (const name of secretNames) {
        if (source.includes(name)) offenders.push(`${path}: ${name}`);
      }
      // A client may name a credential slot, never carry its plaintext.
      if (/plaintextCredential|apiKeyPlaintext|credentialSecret/.test(source)) {
        offenders.push(`${path}: plaintext credential field`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
