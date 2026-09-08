/**
 * One suite, two hosts.
 *
 * This is the file that makes `ComputerHostV1` an interface rather than a
 * description of Fly. Every case below is written against the interface alone
 * and is run twice: once over `@frockbot/computer/fake`, whose Computer is a
 * `Map`, and once over `computer/fly`, whose Computer is reached through the
 * host's wire — stood up by `contractHostV1` on the same double the Fly suites
 * drive, so that every word of that implementation's vocabulary stays inside
 * it. Nothing in a case names either host.
 *
 * It is deliberately the *interface's* behaviour and not the implementations'
 * detail: open and close, a Workspace round-trip, the shape of an exec result,
 * screenshot bytes, a viewer's open/renew/revoke, a control lease taken and
 * given back, and a teardown that is idempotent where a host offers one. A
 * third host is a third entry in `HOSTS` and no new assertion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type {
  WorkspacePathV1,
  WorkspaceWriterV1,
} from "@frockbot/core/contracts";
import type {
  ComputerHostSessionV1,
  ComputerHostV1,
} from "@frockbot/computer/core/host";
import { createFakeComputerHostV1 } from "@frockbot/computer/fake";
import { contractHostV1 } from "./fly/host-double.ts";
import { FLY_WORKSPACE_LAYOUT } from "./fly/provider.ts";

const USER = "contract-user";
const BOT = "contract-bot";

const WRITER: WorkspaceWriterV1 = {
  kind: "bot",
  botId: BOT,
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
};

/** One host under test, and the root a Workspace round-trip may use. */
interface HostUnderTestV1 {
  name: string;
  host: ComputerHostV1;
  path: WorkspacePathV1;
}

function fake(): HostUnderTestV1 {
  const host = createFakeComputerHostV1({
    execDefault: { stdout: "contract\n" },
  });
  return {
    name: "the in-memory host",
    host,
    path: {
      root: {
        kind: "package-declared",
        userId: USER,
        packageId: "@frockbot/app/notes",
        rootId: "notes",
      },
      path: "note.md",
    },
  };
}

function fly(): HostUnderTestV1 {
  return {
    name: "the Fly host",
    host: contractHostV1(USER, BOT),
    path: {
      root: {
        kind: "package-declared",
        userId: USER,
        packageId: "@frockbot/app/notes",
        rootId: "notes",
      },
      path: "note.md",
    },
  };
}

const HOSTS: Array<() => HostUnderTestV1> = [fake, fly];

for (const build of HOSTS) {
  const { name, host, path } = build();
  const sessions: ComputerHostSessionV1[] = [];

  async function open(): Promise<ComputerHostSessionV1> {
    const session = await host.open(
      { userId: USER },
      { botId: BOT },
      { providerId: host.id, generation: 1 },
    );
    sessions.push(session);
    return session;
  }

  describe(`ComputerHostV1 contract: ${name}`, () => {
    afterEach(async () => {
      for (const session of sessions.splice(0)) await session.close();
    });

    test("declares its viewer frame origins before a session exists", () => {
      expect(Array.isArray(host.capabilities.viewerFrameOrigins)).toBe(true);
      expect(host.id.trim()).not.toBe("");
    });

    test("opens a session for a tenant and closes it", async () => {
      const session = await open();

      expect(session.identity.userId).toBe(USER);
      expect(session.tenant.botId).toBe(BOT);
      expect(session.assignment.providerId).toBe(host.id);
      // The declaration on the session is the declaration on the host: a
      // reader that has one must not have to ask the other.
      expect(session.capabilities.viewerFrameOrigins).toEqual(
        host.capabilities.viewerFrameOrigins,
      );
      // Closing is a session ending, not a Computer being destroyed, and it
      // may be asked for twice.
      await session.close();
      await session.close();
    });

    test("round-trips bytes through the Workspace", async () => {
      const session = await open();
      const workspace = session.workspace;
      expect(workspace).toBeDefined();
      const bytes = new TextEncoder().encode("# contract\n");

      const written = await workspace!.write({
        path,
        bytes,
        writer: WRITER,
        expectedGenerationId: null,
      });
      expect(written.status).toBe("ok");
      const read = await workspace!.read(path);

      expect(read.status).toBe("ok");
      if (read.status !== "ok") throw new Error(read.reason);
      expect(read.file.bytes).toEqual(bytes);
      // A path the host has never seen is `not-found` and not a throw: the
      // Workspace answers outcomes.
      expect(
        (await workspace!.read({ ...path, path: "absent.md" })).status,
      ).toBe("not-found");
    });

    test("answers an exec with an exit code and both streams", async () => {
      const session = await open();
      expect(session.exec).toBeDefined();

      const result = await session.exec!.execute({
        executable: "/bin/bash",
        args: ["-lc", "echo contract"],
      });

      expect(
        typeof result.exitCode === "number" || result.exitCode === null,
      ).toBe(true);
      expect(result.stdout).toBeInstanceOf(Uint8Array);
      expect(result.stderr).toBeInstanceOf(Uint8Array);
      expect(result.outputTruncated).toBe(false);
    });

    test("captures a PNG of the Bot's own desktop", async () => {
      const session = await open();
      expect(session.screenshot).toBeDefined();

      const captured = await session.screenshot!.capture();

      expect(captured.mediaType).toBe("image/png");
      expect(captured.bytes.byteLength).toBeGreaterThan(0);
      expect([...captured.bytes.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      expect(Date.parse(captured.capturedAt)).not.toBeNaN();
    });

    test("mints, renews and revokes a viewer session on an opaque URL", async () => {
      const session = await open();
      expect(session.viewer).toBeDefined();

      const opened = await session.viewer!.open();
      const renewed = await session.viewer!.renew(opened.id);
      await session.viewer!.revoke(opened.id);

      expect(opened.id.trim()).not.toBe("");
      // Opaque: the interface promises a URL a browser can frame, and says
      // nothing about its shape beyond an origin the host declared.
      const origin = new URL(opened.url).origin;
      expect(
        host.capabilities.viewerFrameOrigins.some((pattern) =>
          new RegExp(
            `^${pattern.replaceAll(".", "\\.").replaceAll("*", "[^.]+")}$`,
          ).test(origin),
        ),
      ).toBe(true);
      expect(renewed.id).toBe(opened.id);
    });

    test("takes a control lease and gives it back", async () => {
      const session = await open();
      expect(session.control).toBeDefined();

      const lease = await session.control!.acquire({
        scope: "desktop-gui",
        ownerId: "human-1",
      });
      expect(lease.id).toBe("human-1");
      expect(Date.parse(lease.expiresAt)).not.toBeNaN();

      // A second owner is refused while the first holds it, which is the
      // whole point of a User-wide lease.
      await expect(
        session.control!.acquire({
          scope: "desktop-gui",
          ownerId: "human-2",
        }),
      ).rejects.toThrow();

      await session.control!.release(lease, {
        scope: "desktop-gui",
        ownerId: "human-1",
      });
      const second = await session.control!.acquire({
        scope: "desktop-gui",
        ownerId: "human-2",
      });
      expect(second.id).toBe("human-2");
      await session.control!.release(second, {
        scope: "desktop-gui",
        ownerId: "human-2",
      });
    });

    test("tears the Computer down idempotently, where it offers teardown", async () => {
      if (!host.teardown) {
        // Optional by declaration: known issue 27 records that nothing calls
        // it yet, so a host without one is conforming, not broken.
        expect(host.teardown).toBeUndefined();
        return;
      }
      await host.teardown({ userId: USER });
      await host.teardown({ userId: USER });

      // And the host still opens: a torn-down Computer is provisioned again
      // on the next call rather than remembered as destroyed.
      const session = await open();
      expect(session.tenant.botId).toBe(BOT);
    });
  });
}

describe("ComputerHostV1 substitution", () => {
  test("the in-memory host declares a layout of its own", () => {
    const { host } = fake();

    expect(host.workspaceLayout).toBeDefined();
    // The two hosts mount their roots in different places, which is what a
    // substitution has to allow: nothing above the Computer may read a mount
    // path out of one host and expect it of another.
    expect(host.workspaceLayout).not.toEqual(FLY_WORKSPACE_LAYOUT);
  });
});
