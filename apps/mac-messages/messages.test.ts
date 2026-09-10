import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagesSeam } from "./messages";
import { createMachineMessagesDeviceRunnerV1 } from "@frockbot/app/machine-messages/device";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "messages-test-"));
  roots.push(home);
  await mkdir(join(home, "Library/Messages/Attachments"), { recursive: true });
  const db = new Database(join(home, "Library/Messages/chat.db"));
  db.exec(
    "CREATE TABLE message (text TEXT); INSERT INTO message VALUES ('synthetic message')",
  );
  db.close();
  let allowed = false;
  const sent: string[] = [];
  const seam = messagesSeam(home, {
    permissions: async () => allowed,
    send: async (script) => {
      sent.push(script);
    },
  });
  return {
    home,
    seam,
    sent,
    allow: () => {
      allowed = true;
    },
  };
}
const signal = () => new AbortController().signal;
test("database access is read-only and permission checks do not send", async () => {
  const { seam, sent } = await fixture();
  expect(await seam.checkPermissions(signal())).toMatchObject({
    fullDiskAccess: true,
    automation: false,
  });
  expect(
    await seam.query(
      { sql: "SELECT text FROM message", parameters: [], maxRows: 1 },
      signal(),
    ),
  ).toEqual([{ text: "synthetic message" }]);
  await expect(
    seam.query(
      { sql: "DELETE FROM message", parameters: [], maxRows: 1 },
      signal(),
    ),
  ).rejects.toThrow();
  expect(sent).toEqual([]);
});
test("send is refused until Mac automation permission is present", async () => {
  const { seam, sent, allow } = await fixture();
  const runner = createMachineMessagesDeviceRunnerV1({ seam });
  expect(
    (
      await runner(
        { kind: "send", to: "+61400000000", text: "synthetic" },
        signal(),
      )
    ).outcome,
  ).toBe("refused");
  expect(sent).toHaveLength(0);
  allow();
  expect(
    (
      await runner(
        { kind: "send", to: "+61400000000", text: "synthetic" },
        signal(),
      )
    ).outcome,
  ).toBe("ok");
  expect(sent).toHaveLength(1);
});
test("attachments are bounded and cannot escape the Messages attachment directory", async () => {
  const { seam, home } = await fixture();
  const attachment = join(home, "Library/Messages/Attachments/example");
  await writeFile(attachment, "abcdef");
  expect(
    await seam.readFile({ path: attachment, maxBytes: 3 }, signal()),
  ).toEqual({
    bytesBase64: Buffer.from("abc").toString("base64"),
    truncated: true,
  });
  const outside = join(home, "private");
  await writeFile(outside, "secret");
  const link = join(home, "Library/Messages/Attachments/link");
  await symlink(outside, link);
  await expect(
    seam.readFile({ path: link, maxBytes: 10 }, signal()),
  ).rejects.toThrow("outside");
});
test("revoked disk access and cancelled operations fail without sending", async () => {
  const { seam, home, sent } = await fixture();
  await rm(join(home, "Library/Messages/chat.db"));
  expect((await seam.checkPermissions(signal())).fullDiskAccess).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(
    seam.send(
      { recipient: "+61400000000", text: "synthetic" },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(sent).toHaveLength(0);
});
