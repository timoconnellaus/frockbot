// The Messages host, against fake OS calls (register row 57g).
//
// A Mac UI session, Full Disk Access and Automation consent are not things CI
// has, so the two things that can only happen on a Mac — `node:sqlite` opening
// `chat.db`, and `osascript` talking to Messages.app — are injected. What is
// proved here is everything around them: the read-only URI, the parameter
// binding, the row coercion, and the classification of a TCC refusal, which is
// the one piece of judgement this file is allowed to hold.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import {
  MESSAGES_AUTOMATION_PROBE_V1,
  NodeMessagesHostCapability,
  coerceMessagesRowV1,
  coerceMessagesValueV1,
  isMessagesPermissionErrorV1,
  messagesDatabaseUriV1,
  type MessagesDatabaseV1,
  type MessagesRow,
} from "./messages-host.js";

const signal = new AbortController().signal;

interface Fake {
  host: NodeMessagesHostCapability;
  statements: Array<{ sql: string; parameters: Array<string | number> }>;
  scripts: string[];
  closed: number;
  dispose(): Promise<void>;
}

function host(
  options: {
    platform?: string;
    home?: string;
    rows?: MessagesRow[];
    openThrows?: Error;
    scriptThrows?: Error;
  } = {},
): Fake {
  const ctx = new Context();
  const statements: Array<{ sql: string; parameters: Array<string | number> }> =
    [];
  const scripts: string[] = [];
  let closed = 0;
  const capability = new NodeMessagesHostCapability(ctx, {
    platform: options.platform ?? "darwin",
    home: options.home ?? "/Users/tim",
    openDatabase: (path: string): Promise<MessagesDatabaseV1> => {
      if (options.openThrows) return Promise.reject(options.openThrows);
      expect(path).toBe("/Users/tim/Library/Messages/chat.db");
      return Promise.resolve({
        all: (sql, parameters) => {
          statements.push({ sql, parameters });
          return options.rows ?? [{ ok: 1 }];
        },
        close: () => {
          closed += 1;
        },
      });
    },
    runAppleScript: (script: string) => {
      scripts.push(script);
      if (options.scriptThrows) return Promise.reject(options.scriptThrows);
      return Promise.resolve("Messages");
    },
  });
  return {
    host: capability,
    statements,
    scripts,
    get closed() {
      return closed;
    },
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}

describe("opening chat.db", () => {
  test("the connection is read-only, because Messages.app has it open too", () => {
    expect(messagesDatabaseUriV1("/Users/tim/Library/Messages/chat.db")).toBe(
      "file:/Users/tim/Library/Messages/chat.db?mode=ro",
    );
    // A space in a home directory is a path, not two arguments.
    expect(messagesDatabaseUriV1("/Users/tim smith/chat.db")).toBe(
      "file:/Users/tim%20smith/chat.db?mode=ro",
    );
  });
});

describe("what SQLite hands back", () => {
  test("a value becomes something a tool result can carry", () => {
    expect(coerceMessagesValueV1(null)).toBeNull();
    expect(coerceMessagesValueV1(undefined)).toBeNull();
    expect(coerceMessagesValueV1("hi")).toBe("hi");
    expect(coerceMessagesValueV1(4)).toBe(4);
    // `message.date` arrives as a BigInt on some builds, and JSON throws on
    // one; it is a timestamp, so a double loses nothing that matters.
    expect(coerceMessagesValueV1(789_000_000_000_000_000n)).toBe(
      789_000_000_000_000_000,
    );
    expect(coerceMessagesValueV1(true)).toBe(1);
    // A blob is its length, never mojibake in a model's context.
    expect(coerceMessagesValueV1(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(coerceMessagesValueV1(Number.NaN)).toBeNull();
  });

  test("a row is coerced field by field", () => {
    expect(
      coerceMessagesRowV1({ ROWID: 1n, text: "hi", handle: null }),
    ).toEqual({ ROWID: 1, text: "hi", handle: null });
  });
});

describe("permission classification", () => {
  test("every way macOS says no reads as no", () => {
    for (const message of [
      "EPERM: operation not permitted, open '/Users/tim/Library/Messages/chat.db'",
      "SQLITE_CANTOPEN: unable to open database file",
      "Not authorized to send Apple events to Messages. (-1743)",
      "permission denied",
    ]) {
      expect(isMessagesPermissionErrorV1(new Error(message))).toBe(true);
    }
  });

  test("a broken database is not a withheld permission", () => {
    expect(
      isMessagesPermissionErrorV1(
        new Error("database disk image is malformed"),
      ),
    ).toBe(false);
  });
});

describe("checkPermissions", () => {
  test("a Mac that grants both says so, and probes without sending", async () => {
    const fake = host();
    try {
      expect(await fake.host.checkPermissions(signal)).toEqual({
        fullDiskAccess: true,
        automation: true,
      });
      expect(fake.scripts).toEqual([MESSAGES_AUTOMATION_PROBE_V1]);
      expect(fake.statements[0]?.sql).toContain("SELECT 1");
    } finally {
      await fake.dispose();
    }
  });

  test("a withheld grant is reported, not thrown", async () => {
    const fake = host({
      openThrows: new Error("EPERM: operation not permitted"),
      scriptThrows: new Error("Not authorized to send Apple events (-1743)"),
    });
    try {
      const permissions = await fake.host.checkPermissions(signal);
      expect(permissions.fullDiskAccess).toBe(false);
      expect(permissions.automation).toBe(false);
      expect(permissions.detail).toContain("Full Disk Access");
      expect(permissions.detail).toContain("Automation");
    } finally {
      await fake.dispose();
    }
  });

  test("a machine that is not a Mac reports both false and says why", async () => {
    const fake = host({ platform: "linux" });
    try {
      const permissions = await fake.host.checkPermissions(signal);
      expect(permissions).toEqual({
        fullDiskAccess: false,
        automation: false,
        detail: "this machine is not a Mac, so Messages.app is not there",
      });
      // Nothing was opened and nothing was run: there is nothing there to ask.
      expect(fake.statements).toEqual([]);
      expect(fake.scripts).toEqual([]);
    } finally {
      await fake.dispose();
    }
  });
});

describe("query and send", () => {
  test("the statement and its parameters are passed through untouched", async () => {
    const fake = host({ rows: [{ ROWID: 1, text: "hi" }] });
    try {
      const rows = await fake.host.query(
        {
          sql: "SELECT 1 WHERE text LIKE ?1",
          parameters: ["%'; --%"],
          maxRows: 5,
        },
        signal,
      );
      expect(rows).toEqual([{ ROWID: 1, text: "hi" }]);
      expect(fake.statements).toEqual([
        { sql: "SELECT 1 WHERE text LIKE ?1", parameters: ["%'; --%"] },
      ]);
      expect(fake.closed).toBe(1);
    } finally {
      await fake.dispose();
    }
  });

  test("the row bound is honoured even if SQLite over-answers", async () => {
    const fake = host({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    try {
      const rows = await fake.host.query(
        { sql: "SELECT a FROM t", parameters: [], maxRows: 2 },
        signal,
      );
      expect(rows).toHaveLength(2);
    } finally {
      await fake.dispose();
    }
  });

  test("a send runs one script that carries the escaped text", async () => {
    const fake = host();
    try {
      await fake.host.send(
        { recipient: "+61400000000", text: 'say "hi"' },
        signal,
      );
      expect(fake.scripts).toHaveLength(1);
      expect(fake.scripts[0]).toContain('send "say \\"hi\\"" to targetBuddy');
    } finally {
      await fake.dispose();
    }
  });
});

describe("reading an attachment", () => {
  test("a file at the bound is whole and one byte past it is cut", async () => {
    const directory = mkdtempSync(join(tmpdir(), "frockbot-messages-"));
    const path = join(directory, "attachment.bin");
    writeFileSync(path, "abcdef");
    const fake = host();
    try {
      expect(await fake.host.readFile({ path, maxBytes: 6 }, signal)).toEqual({
        bytesBase64: Buffer.from("abcdef").toString("base64"),
        truncated: false,
      });
      expect(await fake.host.readFile({ path, maxBytes: 3 }, signal)).toEqual({
        bytesBase64: Buffer.from("abc").toString("base64"),
        truncated: true,
      });
    } finally {
      await fake.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
