import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  denoRunArgsV1,
  expandModulePathV1,
  moduleCommandV1,
  seatbeltProfileV1,
} from "./sandbox.ts";

const PATHS = {
  deno: "/Applications/FrockBot.app/Contents/Helpers/deno",
  runtime: "/Applications/FrockBot.app/Contents/Resources/device-runtime.js",
  code: "/Users/tim/Library/Application Support/FrockBot/modules/abc.js",
  data: "/Users/tim/Library/Application Support/FrockBot/module-data/beeper",
  home: "/Users/tim",
};
const REACH = {
  read: ["~/Library/Messages/"],
  net: ["localhost:23373"],
  appleEvents: ["com.apple.iChat"],
};

describe("a module's Deno permissions", () => {
  test("read what it declared and its own code, reach its hosts, and nothing else", () => {
    const args = denoRunArgsV1(REACH, PATHS);
    expect(args).toContain(
      `--allow-read=${PATHS.runtime},${PATHS.code},/Users/tim/Library/Messages/`,
    );
    expect(args).toContain("--allow-net=localhost:23373");
    for (const flag of [
      "--deny-write",
      "--deny-env",
      "--deny-run",
      "--deny-ffi",
      "--deny-sys",
      "--no-remote",
      "--cached-only",
    ]) {
      expect(args).toContain(flag);
    }
    expect(
      args.some((arg) => arg.startsWith("--allow-all") || arg === "-A"),
    ).toBe(false);
    expect(args.slice(-2)).toEqual([PATHS.runtime, PATHS.code]);
  });

  test("a module that reaches no host gets no network flag at all", () => {
    expect(
      denoRunArgsV1({ ...REACH, net: [] }, PATHS).some((arg) =>
        arg.startsWith("--allow-net"),
      ),
    ).toBe(false);
  });

  test("~/ is the person's home", () => {
    expect(expandModulePathV1("~/notes", "/Users/tim")).toBe(
      "/Users/tim/notes",
    );
    expect(expandModulePathV1("/etc/hosts", "/Users/tim")).toBe("/etc/hosts");
  });
});

describe("a module's Seatbelt profile", () => {
  const profile = seatbeltProfileV1(REACH, PATHS);

  test("denies by default and adds only what was declared", () => {
    expect(profile.split("\n").slice(0, 2)).toEqual([
      "(version 1)",
      "(deny default)",
    ]);
    expect(profile).toContain(
      '(allow file-read* (subpath "/Users/tim/Library/Messages"))',
    );
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:23373"))',
    );
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${PATHS.data}"))`,
    );
    expect(profile).not.toContain("apple-event");
    expect(profile).not.toContain('file-write* (subpath "/Users/tim")');
  });

  test("refuses a path that could break out of its literal", () => {
    expect(() =>
      seatbeltProfileV1(
        { ...REACH, read: ['~/a") (allow default) ("'] },
        PATHS,
      ),
    ).toThrow(/may not contain quotes/);
  });

  test("the command is Seatbelt around Deno", () => {
    const command = moduleCommandV1(REACH, PATHS);
    expect(command.command).toBe("/usr/bin/sandbox-exec");
    expect(command.args.slice(0, 1)).toEqual(["-p"]);
    expect(command.args[2]).toBe(PATHS.deno);
    expect(command.cwd).toBe(PATHS.data);
    expect(command.env).toEqual({
      DENO_DIR: PATHS.data,
      DENO_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      HOME: "/Users/tim",
    });
  });
});

// With a Deno binary on hand, the flags are proved rather than read: a module
// started with them reads what it declared and is refused the rest.
const DENO = process.env.FROCKBOT_TEST_DENO;
describe.skipIf(!DENO)("Deno's permissions, run", () => {
  test("a module reads its declared path and is refused an undeclared one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "module-deno-"));
    const allowed = join(directory, "allowed.txt");
    const secret = join(directory, "secret.txt");
    await writeFile(allowed, "yes", "utf8");
    await writeFile(secret, "no", "utf8");
    const code = join(directory, "module.mjs");
    await writeFile(
      code,
      `import { readFileSync } from "node:fs";
       export const calls = {};
       const read = (path) => { try { return readFileSync(path, "utf8"); } catch (error) { return error.name; } };
       console.log(JSON.stringify([read(${JSON.stringify(allowed)}), read(${JSON.stringify(secret)})]));
       process.exit(0);`,
      "utf8",
    );
    const runtime = join(import.meta.dir, "runtime.ts");
    const result = spawnSync(
      DENO!,
      denoRunArgsV1(
        { read: [allowed], net: [], appleEvents: [] },
        {
          deno: DENO!,
          runtime,
          code,
          data: join(directory, "data"),
        },
      ).map((arg) => (arg === "--cached-only" ? "--no-lock" : arg)),
      {
        encoding: "utf8",
        env: { DENO_DIR: join(directory, "data"), NO_COLOR: "1" },
      },
    );
    expect(result.stdout).toContain('[\\"yes\\",\\"NotCapable\\"]');
  });
});
