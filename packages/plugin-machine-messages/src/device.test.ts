// What one Messages call becomes on the Mac, proved without a Mac.
import { describe, expect, test } from "bun:test";
import type { MachineMessagesCallV1 } from "@frockbot/machine-protocol";
import {
  MACHINE_MESSAGES_AUTOMATION_REFUSAL_V1,
  MACHINE_MESSAGES_FULL_DISK_REFUSAL_V1,
  appleDateToIsoV1,
  createMachineMessagesDeviceRunnerV1,
  escapeAppleScriptStringV1,
  machineMessagesAttachmentPathV1,
  machineMessagesChatRowV1,
  machineMessagesDatabasePathV1,
  machineMessagesItemRowV1,
  machineMessagesQueryV1,
  machineMessagesSendScriptV1,
  type MachineMessagesDeviceSeamV1,
  type MachineMessagesQueryRequestV1,
  type MachineMessagesRowV1,
} from "./device.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const SIGNAL = new AbortController().signal;

interface Recorded {
  queries: MachineMessagesQueryRequestV1[];
  sent: Array<{ recipient: string; text: string }>;
  reads: Array<{ path: string; maxBytes: number }>;
}

function seamFor(options: {
  permissions?: {
    fullDiskAccess: boolean;
    automation: boolean;
    detail?: string;
  };
  rows?: MachineMessagesRowV1[];
  file?: { bytesBase64: string; truncated: boolean };
  throws?: Error;
}): { seam: MachineMessagesDeviceSeamV1; recorded: Recorded } {
  const recorded: Recorded = { queries: [], sent: [], reads: [] };
  const seam: MachineMessagesDeviceSeamV1 = {
    checkPermissions: async () =>
      options.permissions ?? { fullDiskAccess: true, automation: true },
    query: async (request) => {
      recorded.queries.push(request);
      if (options.throws) throw options.throws;
      return options.rows ?? [];
    },
    send: async (request) => {
      recorded.sent.push(request);
      if (options.throws) throw options.throws;
    },
    readFile: async (request) => {
      recorded.reads.push(request);
      return options.file ?? { bytesBase64: "", truncated: false };
    },
    home: () => "/Users/tim",
  };
  return { seam, recorded };
}

function run(call: MachineMessagesCallV1, seam: MachineMessagesDeviceSeamV1) {
  return createMachineMessagesDeviceRunnerV1({ seam, now: () => NOW })(
    call,
    SIGNAL,
  );
}

function body(stdout: string | undefined): Record<string, unknown> {
  return JSON.parse(stdout ?? "{}") as Record<string, unknown>;
}

describe("chat.db arithmetic", () => {
  test("the database is where macOS keeps it", () => {
    expect(machineMessagesDatabasePathV1("/Users/tim")).toBe(
      "/Users/tim/Library/Messages/chat.db",
    );
    expect(machineMessagesDatabasePathV1("/Users/tim/")).toBe(
      "/Users/tim/Library/Messages/chat.db",
    );
  });

  test("Apple's epoch is read in both the shapes chat.db writes", () => {
    // Nanoseconds since 2001-01-01, which is what a modern macOS writes.
    expect(appleDateToIsoV1(789_000_000_000_000_000)).toBe(
      new Date((789_000_000 + 978_307_200) * 1000).toISOString(),
    );
    // Seconds, which very old rows carry.
    expect(appleDateToIsoV1(789_000_000)).toBe(
      new Date((789_000_000 + 978_307_200) * 1000).toISOString(),
    );
    // A row with no date is a row with no date, not 2001.
    expect(appleDateToIsoV1(0)).toBeUndefined();
    expect(appleDateToIsoV1(null)).toBeUndefined();
    expect(appleDateToIsoV1("yesterday")).toBeUndefined();
    expect(appleDateToIsoV1(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("a `~` attachment path resolves against this account's home", () => {
    expect(
      machineMessagesAttachmentPathV1(
        "~/Library/Messages/Attachments/a.jpg",
        "/Users/tim",
      ),
    ).toBe("/Users/tim/Library/Messages/Attachments/a.jpg");
    expect(machineMessagesAttachmentPathV1("/tmp/a.jpg", "/Users/tim")).toBe(
      "/tmp/a.jpg",
    );
  });

  test("rows become the shapes a tool result renders", () => {
    expect(
      machineMessagesChatRowV1({
        ROWID: 3,
        guid: "iMessage;-;+61400000000",
        chat_identifier: "+61400000000",
        display_name: "Mum",
        last_date: 789_000_000_000_000_000,
      }),
    ).toEqual({
      chatId: "iMessage;-;+61400000000",
      name: "Mum",
      handle: "+61400000000",
      lastMessageAt: new Date((789_000_000 + 978_307_200) * 1000).toISOString(),
    });
    expect(
      machineMessagesItemRowV1({
        ROWID: 91,
        text: "on my way",
        is_from_me: 1,
        date: 789_000_000_000_000_000,
        handle: null,
        chat_guid: "iMessage;-;+61400000000",
        attachment_id: 12,
      }),
    ).toEqual({
      rowId: 91,
      chatId: "iMessage;-;+61400000000",
      fromMe: true,
      text: "on my way",
      at: new Date((789_000_000 + 978_307_200) * 1000).toISOString(),
      attachmentId: "12",
    });
  });
});

describe("the statements", () => {
  test("a search term is a bound parameter and never SQL", () => {
    const query = machineMessagesQueryV1({
      kind: "search",
      query: "'; DROP TABLE message; --",
      limit: 5,
    });
    expect(query.sql).not.toContain("DROP");
    expect(query.parameters).toEqual(["%'; DROP TABLE message; --%"]);
    expect(query.maxRows).toBe(5);
    expect(query.sql.startsWith("SELECT ")).toBe(true);
  });

  test("every read is a SELECT, and the row bound is the call's", () => {
    const calls: MachineMessagesCallV1[] = [
      { kind: "find-chats", limit: 7 },
      { kind: "find-chats", query: "mum", limit: 7 },
      { kind: "chat-items", chatId: "chat-1", limit: 7 },
      { kind: "chat-items", chatId: "chat-1", limit: 7, beforeRowId: 40 },
      { kind: "search", query: "x", limit: 7 },
      { kind: "activity", limit: 7 },
    ];
    for (const call of calls) {
      const query = machineMessagesQueryV1(call);
      expect(query.sql.startsWith("SELECT ")).toBe(true);
      expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ATTACH|PRAGMA)\b/);
      expect(query.maxRows).toBe(7);
    }
    // Paging binds the row id rather than interpolating it.
    expect(
      machineMessagesQueryV1({
        kind: "chat-items",
        chatId: "chat-1",
        limit: 7,
        beforeRowId: 40,
      }).parameters,
    ).toEqual(["chat-1", 40]);
  });

  test("a send is not a chat.db read", () => {
    expect(() =>
      machineMessagesQueryV1({ kind: "send", to: "a", text: "b" }),
    ).toThrow(/not a chat.db read/);
  });
});

describe("AppleScript", () => {
  test("a quote in somebody's message cannot close the string", () => {
    expect(escapeAppleScriptStringV1('say "hi" \\ now')).toBe(
      'say \\"hi\\" \\\\ now',
    );
    const script = machineMessagesSendScriptV1("+61400000000", 'he said "no"');
    expect(script).toContain('send "he said \\"no\\"" to targetBuddy');
    expect(
      script.split("\n").filter((line) => line.includes("send")).length,
    ).toBe(1);
  });

  test("a newline in the message stays a newline", () => {
    expect(escapeAppleScriptStringV1("one\ntwo")).toBe("one\ntwo");
  });
});

describe("the runner", () => {
  test("a permission check always answers, and reports both flags", async () => {
    const { seam } = seamFor({
      permissions: { fullDiskAccess: false, automation: false, detail: "nope" },
    });
    const report = await run({ kind: "check-permissions" }, seam);
    expect(report.outcome).toBe("ok");
    expect(body(report.stdout)).toEqual({
      kind: "permissions",
      permissions: {
        schemaVersion: 1,
        fullDiskAccess: false,
        automation: false,
        checkedAt: "2026-09-01T00:00:00.000Z",
        detail: "nope",
      },
    });
  });

  test("no Full Disk Access refuses every read, visibly, and queries nothing", async () => {
    const { seam, recorded } = seamFor({
      permissions: { fullDiskAccess: false, automation: true },
    });
    const report = await run({ kind: "activity", limit: 5 }, seam);
    expect(report.outcome).toBe("refused");
    expect(report.message).toBe(
      `Refused: ${MACHINE_MESSAGES_FULL_DISK_REFUSAL_V1}`,
    );
    expect(recorded.queries).toEqual([]);
  });

  test("no Automation refuses a send, and sends nothing", async () => {
    const { seam, recorded } = seamFor({
      permissions: { fullDiskAccess: true, automation: false },
    });
    const report = await run({ kind: "send", to: "+61", text: "hi" }, seam);
    expect(report.outcome).toBe("refused");
    expect(report.message).toBe(
      `Refused: ${MACHINE_MESSAGES_AUTOMATION_REFUSAL_V1}`,
    );
    expect(recorded.sent).toEqual([]);
  });

  test("a read returns its rows as data", async () => {
    const { seam, recorded } = seamFor({
      rows: [
        {
          ROWID: 3,
          guid: "chat-1",
          chat_identifier: "+61400000000",
          display_name: "Mum",
          last_date: 789_000_000_000_000_000,
        },
      ],
    });
    const report = await run({ kind: "find-chats", limit: 5 }, seam);
    expect(report.outcome).toBe("ok");
    expect(body(report.stdout).kind).toBe("chats");
    expect(recorded.queries).toHaveLength(1);
  });

  test("a send that is permitted reaches Messages.app once", async () => {
    const { seam, recorded } = seamFor({});
    const report = await run({ kind: "send", to: "+61", text: "hi" }, seam);
    expect(report.outcome).toBe("ok");
    expect(recorded.sent).toEqual([{ recipient: "+61", text: "hi" }]);
    expect(body(report.stdout).kind).toBe("sent");
  });

  test("an attachment is read off the disk at the path chat.db named", async () => {
    const { seam, recorded } = seamFor({
      rows: [
        {
          ROWID: 12,
          guid: "att-1",
          filename: "~/Library/Messages/Attachments/a.jpg",
          mime_type: "image/jpeg",
          total_bytes: 4,
        },
      ],
      file: { bytesBase64: "AAAA", truncated: true },
    });
    const report = await run(
      { kind: "fetch-attachment", attachmentId: "12", maxBytes: 1024 },
      seam,
    );
    expect(report.outcome).toBe("ok");
    expect(report.bytesBase64).toBe("AAAA");
    expect(report.truncated).toBe(true);
    expect(recorded.reads).toEqual([
      { path: "/Users/tim/Library/Messages/Attachments/a.jpg", maxBytes: 1024 },
    ]);
  });

  test("an attachment that is not there is a refusal, not an error", async () => {
    const { seam, recorded } = seamFor({ rows: [] });
    const report = await run(
      { kind: "fetch-attachment", attachmentId: "99", maxBytes: 1024 },
      seam,
    );
    expect(report.outcome).toBe("refused");
    expect(report.message).toContain("Refused:");
    expect(recorded.reads).toEqual([]);
  });

  test("a thrown seam is an answer, never a thrown runner", async () => {
    const { seam } = seamFor({ throws: new Error("database is locked") });
    const report = await run({ kind: "activity", limit: 5 }, seam);
    expect(report.outcome).toBe("error");
    expect(report.message).toContain("database is locked");
  });
});
