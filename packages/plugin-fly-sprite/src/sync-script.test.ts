/// <reference types="bun" />

// The scan manifest, run as the shell the Sprite runs.
//
// Every other test in this Package interprets the sync's bash in TypeScript
// (`FakeSyncSprite`), which is fast, hermetic, and exactly as wrong as the
// interpreter is. It was wrong about one thing for two production incidents:
// the list of required paths is newline-*separated*, so `while read` dropped
// the last entry of it, and the last entry is always `dist/manifest.json`. The
// interpreter split on "\n" and saw three paths where the shell saw two, so
// every publish lost its manifest and every test said the sync was fine.
//
// So this file runs the real emitted document under a real bash against a real
// directory. It needs bash 4+ and GNU coreutils, which is what a Sprite has and
// what CI has; on a machine without them it says so rather than pretending to
// pass.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceRootV1 } from "@frockbot/kernel-contracts";
import { computerBotKey } from "./computer.ts";
import { FLY_WORKSPACE_LAYOUT } from "./provider.ts";
import { FlySpriteSyncSurface } from "./sync.ts";

const USER = "owner";
// The Applet id from the production failure: a dot in the middle, which is
// exactly the shape a careless path normalization would mangle.
const APPLET = "vgpqfaCcwnPlz.e1f813c4b3398e3ee947b323b9996491";

const appletSourceRoot: WorkspaceRootV1 = {
  kind: "package-declared",
  userId: USER,
  packageId: "applets",
  rootId: "source",
};

/**
 * A bash that supports process substitution and `printf -v`, with GNU
 * `base64 -w0`, `stat -c`, and `sha256sum` on its PATH. Linux has both as
 * itself; macOS needs Homebrew's bash and coreutils.
 */
async function gnuShell(): Promise<{ bash: string; path: string } | undefined> {
  const candidates = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "bash"];
  const prefixes = [
    "/opt/homebrew/opt/coreutils/libexec/gnubin",
    "/usr/local/opt/coreutils/libexec/gnubin",
  ].filter((entry) => existsSync(`${entry}/base64`));
  for (const bash of candidates) {
    for (const prefix of [...prefixes, undefined]) {
      const path = prefix ? `${prefix}:${process.env.PATH}` : process.env.PATH;
      try {
        // A missing interpreter throws out of `spawn` rather than exiting
        // non-zero, so the probe for one has to catch as well as check.
        const probe = Bun.spawn([bash, "-c", "printf '' | base64 -w0"], {
          env: { ...process.env, ...(path ? { PATH: path } : {}) },
          stdout: "ignore",
          stderr: "ignore",
        });
        if ((await probe.exited) === 0) return { bash, path: path ?? "" };
      } catch {
        // No such bash on this machine; try the next candidate.
      }
    }
  }
  return undefined;
}

interface ScanRow {
  tag: string;
  path: string;
  meta: string;
  contentHash: string;
  size: string;
}

/** Captures the exact document `scan` would send, without a Computer. */
async function emitted(requiredPaths: readonly string[]): Promise<string> {
  let script = "";
  const surface = new FlySpriteSyncSurface({
    computer: {
      runStorage: (text: string) => {
        if (text.includes("append_manifest")) script = text;
        return Promise.resolve("");
      },
    } as never,
    layout: FLY_WORKSPACE_LAYOUT,
    userId: USER,
    botDirectoryKey: computerBotKey,
  });
  await surface.scan(appletSourceRoot, requiredPaths);
  if (!script) throw new Error("the scan emitted no manifest script");
  return script;
}

function write(root: string, relative: string, text: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** A generation sidecar in the shape `decodeMeta` reads back. */
function sidecar(id: string): string {
  return `${id}\n${JSON.stringify({
    schemaVersion: 1,
    generationId: id,
    contentHash: "0".repeat(64),
    size: 1,
    writer: { kind: "unattributed" },
    writtenAt: "2026-09-05T00:00:00.000Z",
  })}`;
}

async function run(
  shell: { bash: string; path: string },
  script: string,
  root: string,
): Promise<ScanRow[]> {
  const process_ = Bun.spawn([shell.bash], {
    stdin: new Blob([script.replace(/^ROOT='[^']*'$/m, `ROOT='${root}'`)]),
    env: { ...process.env, ...(shell.path ? { PATH: shell.path } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    process_.exited,
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
  ]);
  expect(err).toBe("");
  expect(code).toBe(0);
  return out
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => {
      const [tag = "", path = "", meta = "", contentHash = "", size = ""] =
        row.split("\t");
      return {
        tag,
        path: tag === "X" ? path : Buffer.from(path, "base64").toString("utf8"),
        meta,
        contentHash,
        size,
      };
    });
}

const shell = await gnuShell();

describe("the scan manifest, under a real shell", () => {
  if (!shell) {
    test("needs bash 4+ and GNU coreutils, which this machine has not got", () => {
      expect(shell).toBeUndefined();
    });
    return;
  }

  // Production, 2026-09-04 and 2026-09-05: `applet build` wrote all three
  // files, the publish sync reported `ok` and moved nothing, and the publish
  // said `"dist/manifest.json" is not-found: run applet build first`. On the
  // Computer the two other files had generation sidecars and the manifest had
  // none — the signature of a manifest row that was never emitted at all.
  test("emits a row for every required path, including the last one", async () => {
    const required = [
      `${APPLET}/dist/server.js`,
      `${APPLET}/dist/ui.html`,
      `${APPLET}/dist/manifest.json`,
    ];
    const root = mkdtempSync(join(tmpdir(), "frockbot-scan-"));
    write(root, required[0]!, "export class Applet {}");
    write(root, required[1]!, "<h1>hi</h1>");
    write(root, required[2]!, '{"contract":1,"tools":[]}');
    // The state the Computer was actually in: sidecars for the two files
    // earlier runs had managed to push, and none for the manifest.
    write(root, `.frockbot-generations/${required[0]!}`, sidecar("gen-1"));
    write(root, `.frockbot-generations/${required[1]!}`, sidecar("gen-2"));

    const rows = await run(shell, await emitted(required), root);

    expect(
      rows.filter((row) => row.tag === "F").map((row) => row.path),
    ).toEqual(required);
    const manifest = rows.find((row) => row.path === required[2]);
    expect(manifest?.meta).toBe("");
    expect(manifest?.size).toBe("25");
    expect(manifest?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("emits the one row of a single-path required list", async () => {
    const required = [`${APPLET}/dist/manifest.json`];
    const root = mkdtempSync(join(tmpdir(), "frockbot-scan-"));
    write(root, required[0]!, "{}");

    const rows = await run(shell, await emitted(required), root);

    expect(
      rows.filter((row) => row.tag === "F").map((row) => row.path),
    ).toEqual(required);
  });

  test("emits nothing for a required path the Computer does not hold", async () => {
    const required = [`${APPLET}/dist/manifest.json`];
    const root = mkdtempSync(join(tmpdir(), "frockbot-scan-"));
    mkdirSync(root, { recursive: true });

    const rows = await run(shell, await emitted(required), root);

    expect(rows.filter((row) => row.tag === "F")).toEqual([]);
    expect(rows.at(-1)?.tag).toBe("X");
  });

  // The bound the required list exists to get around: `dist/` is pruned from
  // the ordinary walk, so a required path is the only way its bytes are seen,
  // and the walk must still prune everything it always pruned.
  test("still prunes reproducible trees while carrying the required paths", async () => {
    const required = [`${APPLET}/dist/manifest.json`];
    const root = mkdtempSync(join(tmpdir(), "frockbot-scan-"));
    write(root, required[0]!, "{}");
    write(root, `${APPLET}/dist/ui.html`, "<h1>not required</h1>");
    write(root, `${APPLET}/src/index.ts`, "export const x = 1;");
    write(root, `${APPLET}/node_modules/dep/package.json`, "{}");

    const rows = await run(shell, await emitted(required), root);

    expect(
      rows.filter((row) => row.tag === "F").map((row) => row.path),
    ).toEqual([required[0]!, `${APPLET}/src/index.ts`]);
    // One pruned directory: `node_modules`. `dist` is not counted, because a
    // required path made it a directory the caller asked to see into.
    expect(rows.at(-1)).toMatchObject({ tag: "X", path: "1", meta: "0" });
  });
});
