// Constitutional check — "Provider types stay in their adapter".
//
// The registered machine's agent is the first Package that can run a shell
// command on somebody's laptop, and the rule that keeps that honest is where
// the two dangerous imports may appear:
//
//   * `electron` — the widest authority FrockBot has — only inside the Electron
//     main process and its preload, which is `apps/desktop/src` (and the
//     Electron proof-of-concept app that exists to exercise it).
//   * `child_process` — only in the Electron main process, where a
//     `trusted-main` desktop Contribution reaches it through a capability, and
//     in the end-to-end harness that starts the dev server.
//
// No Package under `packages/` may import either. That is what makes
// `@frockbot/plugin-user-machine`'s agent loop testable in CI: it cannot
// silently acquire a process to spawn, so every decision it makes has to be
// expressible over an injected seam.
//
// Like the other authority checks, the rule is a pure function of a scan so a
// violation can be staged without writing one into this tree.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** Spelled in halves so this file is not itself a violation of its own rule. */
const ELECTRON = ["elec", "tron"].join("");
const CHILD_PROCESS = ["child", "_process"].join("");

interface ScannedSource {
  /** Repo-relative path. */
  path: string;
  /** Every module specifier the file imports or requires. */
  specifiers: string[];
}

const SPECIFIER = /(?:from|import|require\()\s*["']([^"']+)["']/g;

function scanSources(): ScannedSource[] {
  return [
    ...new Bun.Glob("{packages,apps,applications}/**/*.{ts,vue}").scanSync({
      cwd: repoRoot,
    }),
  ]
    .filter((path) => !path.includes("node_modules/"))
    .filter((path) => !path.includes("/dist/"))
    .filter((path) => !path.includes("/out/"))
    .sort()
    .map((path) => {
      const source = readFileSync(resolve(repoRoot, path), "utf8");
      return {
        path,
        specifiers: [...source.matchAll(SPECIFIER)].map((match) => match[1]!),
      };
    });
}

/** Where each dangerous import is permitted, and nowhere else. */
const ALLOWED = {
  electron: [/^apps\/desktop\/src\//, /^apps\/cordis-poc\/src\//],
  childProcess: [
    /^apps\/desktop\/src\/main\//,
    // The Playwright harness starts `wrangler dev`; it is a test runner, not a
    // Package, and it never ships.
    /^apps\/cloudflare\/e2e\//,
  ],
} as const;

export function desktopProviderOffenders(
  sources: readonly ScannedSource[],
): string[] {
  const offenders: string[] = [];
  for (const { path, specifiers } of sources) {
    for (const specifier of specifiers) {
      const electron =
        specifier === ELECTRON || specifier.startsWith(`${ELECTRON}/`);
      const child =
        specifier === CHILD_PROCESS || specifier === `node:${CHILD_PROCESS}`;
      if (!electron && !child) continue;
      const allowed = electron ? ALLOWED.electron : ALLOWED.childProcess;
      if (allowed.some((pattern) => pattern.test(path))) continue;
      offenders.push(`${path}: ${specifier}`);
    }
  }
  return offenders;
}

describe("desktop provider boundaries", () => {
  test("Electron and child_process are imported only where they may be", () => {
    expect(desktopProviderOffenders(scanSources())).toEqual([]);
  });

  test("no Package under packages/ reaches either of them", () => {
    const offenders = scanSources()
      .filter((source) => source.path.startsWith("packages/"))
      .flatMap((source) =>
        source.specifiers
          .filter(
            (specifier) =>
              specifier === ELECTRON ||
              specifier.startsWith(`${ELECTRON}/`) ||
              specifier === CHILD_PROCESS ||
              specifier === `node:${CHILD_PROCESS}`,
          )
          .map((specifier) => `${source.path}: ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });

  test("the rule bites on a staged violation", () => {
    expect(
      desktopProviderOffenders([
        {
          path: "packages/plugin-user-machine/src/desktop.ts",
          specifiers: [`node:${CHILD_PROCESS}`, "@frockbot/desktop-core"],
        },
        {
          path: "packages/plugin-user-machine/src/device.ts",
          specifiers: [ELECTRON],
        },
        {
          path: "apps/cloudflare/src/index.ts",
          specifiers: [`${ELECTRON}/main`],
        },
        // Permitted, and must stay permitted.
        {
          path: "apps/desktop/src/main/machine-host.ts",
          specifiers: [`node:${CHILD_PROCESS}`],
        },
        {
          path: "apps/desktop/src/preload/index.ts",
          specifiers: [ELECTRON],
        },
      ]),
    ).toEqual([
      `packages/plugin-user-machine/src/desktop.ts: node:${CHILD_PROCESS}`,
      `packages/plugin-user-machine/src/device.ts: ${ELECTRON}`,
      `apps/cloudflare/src/index.ts: ${ELECTRON}/main`,
    ]);
  });

  test("a lookalike specifier is not the real thing", () => {
    expect(
      desktopProviderOffenders([
        {
          path: "apps/cloudflare/src/index.ts",
          specifiers: [
            `@better-auth/${ELECTRON}/client`,
            `${CHILD_PROCESS}-promise`,
          ],
        },
      ]),
    ).toEqual([]);
  });
});
