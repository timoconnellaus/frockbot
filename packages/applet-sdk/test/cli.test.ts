import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApplet } from "../src/cli/build.js";
import { checkApplet } from "../src/cli/check.js";
import { startAppletDev } from "../src/cli/dev.js";
import { appletIdFrom, newApplet } from "../src/cli/new.js";
import { decodeDescriptor } from "../src/cli/manifest.js";
import { formatDiagnostic } from "../src/lint/index.js";
import {
  decodeServerFrame,
  type AppletServerFrameV1,
} from "../src/protocol/index.js";

const workspaces: string[] = [];

async function scaffold(name = "Weekly Todos"): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "applet-"));
  workspaces.push(parent);
  const created = await newApplet({ name, parent });
  return created.directory;
}

afterAll(() => {
  // The temp directories are the OS's problem; nothing here holds a handle.
});

describe("applet new", () => {
  it("slugs a display name into an id", () => {
    expect(appletIdFrom("Weekly Todos")).toBe("weekly-todos");
    expect(appletIdFrom("  Trip   Plan!  ")).toBe("trip-plan");
    expect(() => appletIdFrom("!!!")).toThrow(/usable Applet id/);
  });

  it("writes a scaffold with the name filled in", async () => {
    const directory = await scaffold();
    const descriptor = decodeDescriptor(
      JSON.parse(await readFile(join(directory, "applet.json"), "utf8")),
    );
    expect(descriptor).toEqual({
      id: "weekly-todos",
      displayName: "Weekly Todos",
      contract: 1,
    });
    expect(await readFile(join(directory, "ui.tsx"), "utf8")).toContain(
      "Weekly Todos",
    );
  });

  it("refuses to overwrite an existing Applet", async () => {
    const directory = await scaffold();
    await expect(
      newApplet({ name: "Weekly Todos", parent: join(directory, "..") }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("applet check", () => {
  it("passes on a fresh template", async () => {
    const diagnostics = await checkApplet(await scaffold());
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, 120_000);

  it("reports a type error with a path, a line, and a column", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "extra.ts"),
      'export const n: number = "not a number";\n',
      "utf8",
    );
    const diagnostics = await checkApplet(directory);
    expect(diagnostics[0]!.file).toBe("extra.ts");
    expect(diagnostics[0]!.line).toBe(1);
    expect(formatDiagnostic(diagnostics[0]!)).toMatch(/^extra\.ts:1:\d+ /);
  }, 120_000);

  it("reports a lint violation the type checker would accept", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "extra.ts"),
      'export const brand = "#ff0000";\n',
      "utf8",
    );
    const diagnostics = await checkApplet(directory);
    expect(
      diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain("applet/no-raw-colors");
  }, 120_000);
});

describe("applet build", () => {
  it("emits a server module, a self-contained page, and a manifest", async () => {
    const directory = await scaffold();
    const result = await buildApplet(directory);

    const server = await readFile(result.serverPath, "utf8");
    const imports = [
      ...server.matchAll(/^\s*import\s.*?from\s*"([^"]+)"/gm),
    ].map((match) => match[1]);
    expect(imports).toEqual(["cloudflare:workers"]);
    expect(server).toContain("export {");

    const html = await readFile(result.uiPath, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/\ssrc=["']https?:/);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);

    expect(result.manifest.contract).toBe(1);
    expect(result.manifest.tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "list_todos",
    ]);
    expect(result.manifest.tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
    expect(result.manifest.hashes.server).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest.hashes.ui).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

describe("applet dev", () => {
  it("serves the page, acks an insert, and broadcasts it to a second socket", async () => {
    const directory = await scaffold();
    await buildApplet(directory);
    const server = await startAppletDev({ directory, port: 0 });
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("applet-root");

      const socketUrl = (suffix: string) =>
        `${server.url.toString().replace(/^http/, "ws")}socket?token=${server.token}&viewer=${suffix}`;

      const first = await open(socketUrl("one"));
      const second = await open(socketUrl("two"));

      // Both take a snapshot before anything is written.
      first.send(JSON.stringify({ v: 1, type: "hello", contract: 1 }));
      second.send(JSON.stringify({ v: 1, type: "hello", contract: 1 }));
      await first.waitFor("snapshot");
      await second.waitFor("snapshot");

      first.send(
        JSON.stringify({
          v: 1,
          type: "mutate",
          txnId: "txn-1",
          mutations: [
            {
              table: "todos",
              op: "insert",
              value: { title: "milk", createdAt: "2026-09-03T00:00:00.000Z" },
            },
          ],
        }),
      );

      const ack = await first.waitFor("ack");
      expect(ack.txnId).toBe("txn-1");
      expect(ack.changes[0]!.row).toMatchObject({ title: "milk" });

      const changes = await second.waitFor("changes");
      expect(changes.txnId).toBe("txn-1");
      expect(changes.changes[0]!.op).toBe("insert");
      expect(changes.changes[0]!.row).toMatchObject({ title: "milk" });

      first.close();
      second.close();
    } finally {
      await server.dispose();
    }
  }, 120_000);
});

/**
 * A plain Node WebSocket client with a frame queue. Frames go through the
 * SDK's own decoder, so the test also proves the server emits valid v1.
 */
async function open(url: string) {
  const socket = new WebSocket(url);
  const frames: AppletServerFrameV1[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    frames.push(decodeServerFrame(String(event.data)));
    for (const waiter of waiters.splice(0)) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), {
      once: true,
    });
  });
  return {
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
    async waitFor<T extends AppletServerFrameV1["type"]>(
      type: T,
    ): Promise<Extract<AppletServerFrameV1, { type: T }>> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const index = frames.findIndex((frame) => frame.type === type);
        if (index >= 0) {
          return frames.splice(index, 1)[0] as Extract<
            AppletServerFrameV1,
            { type: T }
          >;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for a "${type}" frame`);
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}
