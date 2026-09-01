// Messages.app, as the only three things a Mac can do that nothing else can
// (parity register row 57g).
//
// It holds no policy. It does not choose a statement, decide what a row means,
// compose an AppleScript, or decide whether a call is allowed — all of that is
// in `@frockbot/plugin-machine-messages`, where it runs in CI. What is here is
// the part that cannot run anywhere but a Mac with a real login session:
// opening `chat.db` read-only, running `osascript`, and reading an attachment
// off the disk.
//
// Every OS call is behind an injected seam for exactly one reason: a Mac UI
// session, Full Disk Access and Automation consent are not things CI has. So
// the classification of a permission error, the read-only URI, the parameter
// binding and the row coercion are all proved here against fakes, and what
// remains untested is `node:sqlite` and `osascript` themselves.

import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import {
  DesktopMessagesCapability,
  type DesktopMachineFileRequest,
  type DesktopMachineFileResult,
  type DesktopMessagesPermissions,
  type DesktopMessagesQueryRequest,
  type DesktopMessagesSendRequest,
} from "@frockbot/desktop-core";
import {
  machineMessagesDatabasePathV1,
  machineMessagesSendScriptV1,
} from "@frockbot/plugin-machine-messages/device";
import type { Context } from "cordis";

/** One row, as SQLite hands it back. */
export type MessagesRow = Record<string, string | number | null>;

/** The database, narrowed to the one thing this file does with it. */
export interface MessagesDatabaseV1 {
  all(sql: string, parameters: Array<string | number>): MessagesRow[];
  close(): void;
}

/**
 * A value SQLite returned, as the seam promises it.
 *
 * `bigint` is the one that bites: `message.date` is nanoseconds since 2001 and
 * arrives as a BigInt on some builds, which `JSON.stringify` throws on. Numbers
 * that large lose no meaningful precision as doubles here — the value is a
 * timestamp, not an identity — and a `Uint8Array` blob becomes its byte length
 * rather than riding into a tool result as mojibake.
 */
export function coerceMessagesValueV1(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value.byteLength;
  return String(value);
}

export function coerceMessagesRowV1(row: Record<string, unknown>): MessagesRow {
  const coerced: MessagesRow = {};
  for (const [key, value] of Object.entries(row)) {
    coerced[key] = coerceMessagesValueV1(value);
  }
  return coerced;
}

/**
 * Whether an error is macOS refusing consent, rather than the database being
 * missing or broken.
 *
 * TCC does not answer "denied": it answers `EPERM`, or `SQLITE_CANTOPEN`, or
 * `operation not permitted`, depending on which layer notices first. Reading
 * them all as "not granted" is the honest classification, because the
 * remediation is the same sentence in every one of those cases.
 */
export function isMessagesPermissionErrorV1(error: unknown): boolean {
  const text = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    text.includes("eperm") ||
    text.includes("operation not permitted") ||
    text.includes("unable to open database") ||
    text.includes("cantopen") ||
    text.includes("authorization") ||
    text.includes("not authorized") ||
    text.includes("-1743") ||
    text.includes("permission denied")
  );
}

/**
 * The read-only URI a `chat.db` connection opens.
 *
 * `mode=ro` and `immutable=0`: Messages.app has the database open and writes to
 * it constantly, so a writable handle risks a lock on somebody's live messaging
 * app, and an immutable one would read stale pages.
 */
export function messagesDatabaseUriV1(path: string): string {
  return `file:${encodeURI(path)}?mode=ro`;
}

/** The AppleScript one permission probe runs. Names Messages, sends nothing. */
export const MESSAGES_AUTOMATION_PROBE_V1 =
  'tell application "Messages" to get name';

export interface NodeMessagesHostOptionsV1 {
  /** `process.platform`, injected so a test can ask for another platform. */
  platform?: string;
  /** `os.homedir()`, injected for the same reason. */
  home?: string;
  /** Opens `chat.db` read-only. Defaults to `node:sqlite`. */
  openDatabase?(path: string): Promise<MessagesDatabaseV1>;
  /** Runs one AppleScript. Defaults to `osascript`. */
  runAppleScript?(script: string, signal: AbortSignal): Promise<string>;
}

/** `node:sqlite`, loaded only when a real read happens. */
async function openSqliteDatabaseV1(path: string): Promise<MessagesDatabaseV1> {
  const sqlite = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (
      location: string,
      options?: Record<string, unknown>,
    ) => {
      prepare(sql: string): {
        all(
          ...parameters: Array<string | number>
        ): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  const database = new sqlite.DatabaseSync(messagesDatabaseUriV1(path), {
    readOnly: true,
  });
  return {
    all: (sql, parameters) =>
      database
        .prepare(sql)
        .all(...parameters)
        .map((row) => coerceMessagesRowV1(row)),
    close: () => database.close(),
  };
}

function runOsascriptV1(script: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        signal.removeEventListener("abort", onAbort);
        if (error) {
          reject(new Error(`${error.message} ${stderr}`.trim()));
          return;
        }
        resolve(stdout);
      },
    );
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class NodeMessagesHostCapability extends DesktopMessagesCapability {
  private readonly platform: string;
  private readonly homeDirectory: string;
  private readonly openDatabase: (path: string) => Promise<MessagesDatabaseV1>;
  private readonly runAppleScript: (
    script: string,
    signal: AbortSignal,
  ) => Promise<string>;

  constructor(ctx: Context, options: NodeMessagesHostOptionsV1 = {}) {
    super(ctx);
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = options.home ?? homedir();
    this.openDatabase = options.openDatabase ?? openSqliteDatabaseV1;
    this.runAppleScript = options.runAppleScript ?? runOsascriptV1;
  }

  home(): string {
    return this.homeDirectory;
  }

  /**
   * Both permissions, probed rather than assumed.
   *
   * The Full Disk Access probe is a real one-row read, because that is the only
   * thing TCC actually answers; asking the OS "am I allowed" is not an API that
   * exists. The Automation probe names Messages.app and asks for nothing, so a
   * Mac that has granted it is not disturbed and one that has not answers the
   * error that says so.
   */
  async checkPermissions(
    signal: AbortSignal,
  ): Promise<DesktopMessagesPermissions> {
    signal.throwIfAborted();
    if (this.platform !== "darwin") {
      return {
        fullDiskAccess: false,
        automation: false,
        detail: "this machine is not a Mac, so Messages.app is not there",
      };
    }
    const details: string[] = [];
    let fullDiskAccess = false;
    try {
      const rows = await this.read(
        "SELECT 1 AS ok FROM message LIMIT 1",
        [],
        1,
      );
      fullDiskAccess = Array.isArray(rows);
    } catch (error) {
      details.push(
        isMessagesPermissionErrorV1(error)
          ? "Full Disk Access has not been granted to FrockBot"
          : `the Messages database could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let automation = false;
    try {
      await this.runAppleScript(MESSAGES_AUTOMATION_PROBE_V1, signal);
      automation = true;
    } catch (error) {
      details.push(
        isMessagesPermissionErrorV1(error)
          ? "Automation over Messages.app has not been granted to FrockBot"
          : `Messages.app could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      fullDiskAccess,
      automation,
      ...(details.length === 0 ? {} : { detail: details.join("; ") }),
    };
  }

  private async read(
    sql: string,
    parameters: Array<string | number>,
    maxRows: number,
  ): Promise<MessagesRow[]> {
    const database = await this.openDatabase(
      machineMessagesDatabasePathV1(this.homeDirectory),
    );
    try {
      return database.all(sql, parameters).slice(0, maxRows);
    } finally {
      database.close();
    }
  }

  async query(
    request: DesktopMessagesQueryRequest,
    signal: AbortSignal,
  ): Promise<MessagesRow[]> {
    signal.throwIfAborted();
    return this.read(request.sql, request.parameters, request.maxRows);
  }

  async send(
    request: DesktopMessagesSendRequest,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runAppleScript(
      machineMessagesSendScriptV1(request.recipient, request.text),
      signal,
    );
  }

  /**
   * One attachment, up to `maxBytes`. `maxBytes + 1` is read so truncation is a
   * fact rather than a guess, exactly as the machine host reads a file.
   */
  async readFile(
    request: DesktopMachineFileRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineFileResult> {
    signal.throwIfAborted();
    const handle = await open(request.path, "r");
    try {
      const buffer = Buffer.alloc(request.maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      const truncated = bytesRead > request.maxBytes;
      const bytes = buffer.subarray(
        0,
        truncated ? request.maxBytes : bytesRead,
      );
      return { bytesBase64: bytes.toString("base64"), truncated };
    } finally {
      await handle.close();
    }
  }
}
