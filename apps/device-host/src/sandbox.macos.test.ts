// The Seatbelt profile, proved on macOS: Deno is started with every
// permission, so only the profile stands between the module and the machine.
// It must still start, read what it declared, write its own data directory,
// reach its declared port — and be refused everything else.
//
// Runs where `sandbox-exec` exists and a Deno binary is named by
// FROCKBOT_TEST_DENO: the Mac desktop workflow provides both.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seatbeltProfileV1 } from "./sandbox.ts";

const DENO = process.env.FROCKBOT_TEST_DENO;

async function listen(): Promise<{ port: number; close(): void }> {
  const server = createServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, close: () => server.close() };
}

describe.skipIf(process.platform !== "darwin" || !DENO)(
  "the Seatbelt profile, run",
  () => {
    test("confines a module that Deno would let do anything", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "module-sb-")));
      const declared = join(root, "declared");
      const data = join(root, "data");
      await mkdir(declared);
      await mkdir(data);
      const allowed = join(declared, "note.txt");
      const secret = join(root, "secret.txt");
      await writeFile(allowed, "yes", "utf8");
      await writeFile(secret, "no", "utf8");
      const open = await listen();
      const closed = await listen();
      const code = join(root, "module.mjs");
      await writeFile(
        code,
        `import { readFileSync, writeFileSync } from "node:fs";
         const attempt = async (work) => { try { return await work(); } catch (error) { return "refused"; } };
         const connect = (port) => attempt(async () => {
           const connection = await Deno.connect({ hostname: "127.0.0.1", port });
           connection.close();
           return "connected";
         });
         const outcome = {
           declared: await attempt(() => readFileSync(${JSON.stringify(allowed)}, "utf8")),
           secret: await attempt(() => readFileSync(${JSON.stringify(secret)}, "utf8")),
           ownData: await attempt(() => { writeFileSync(${JSON.stringify(join(data, "x"))}, "1"); return "wrote"; }),
           elsewhere: await attempt(() => { writeFileSync(${JSON.stringify(join(root, "x"))}, "1"); return "wrote"; }),
           declaredPort: await connect(${open.port}),
           otherPort: await connect(${closed.port}),
         };
         console.log("OUTCOME " + JSON.stringify(outcome));
         Deno.exit(0);`,
        "utf8",
      );
      const profile = seatbeltProfileV1(
        {
          read: [`${declared}/`],
          net: [`localhost:${open.port}`],
          appleEvents: [],
        },
        { deno: DENO!, runtime: code, code, data },
      );
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, DENO!, "run", "-A", "--no-config", code],
        {
          encoding: "utf8",
          env: { DENO_DIR: data, NO_COLOR: "1", HOME: root },
          cwd: data,
        },
      );
      open.close();
      closed.close();
      const line = result.stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("OUTCOME "));
      if (!line) {
        throw new Error(
          `the sandboxed module did not run:\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(JSON.parse(line.slice("OUTCOME ".length))).toEqual({
        declared: "yes",
        secret: "refused",
        ownData: "wrote",
        elsewhere: "refused",
        declaredPort: "connected",
        otherPort: "refused",
      });
    }, 60_000);
  },
);
