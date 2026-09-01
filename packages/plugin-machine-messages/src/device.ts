// What one Messages call becomes on the Mac — everything but the OS calls.
//
// This is row 57g's half of "the plan's honest floor": the SQL that reads
// `chat.db`, the Apple-epoch arithmetic, the row shapes, the AppleScript a send
// composes, and every classification decision — which outcome a missing
// attachment gets, what a denied permission answers, what `truncated` means —
// all live here, in a Package, under `bun test`. What is left for
// `apps/desktop/src/main` is three verbs it cannot avoid being Node for:
// opening a SQLite file read-only, running `osascript`, and reading bytes off a
// disk.
//
// Two rules this file exists to hold:
//
//  1. **The database is never written and never asked for anything but rows.**
//     The seam takes a statement and parameters, and every statement here is a
//     `SELECT`. A Bot's text reaches SQLite only as a bound parameter, so a
//     message containing a quote is a message and not a query.
//  2. **Permissions are checked on the machine, every call.** The backend
//     refuses on the last *report*; this refuses on what is true right now. The
//     two are not redundant: TCC consent can be withdrawn between a Turn and
//     the poll that carries its command.
import {
  MACHINE_LIMITS_V1,
  MACHINE_MESSAGES_LIMITS_V1,
  type MachineMessagesCallV1,
  type MachineMessagesPermissionsV1,
} from "@frockbot/machine-protocol";
import type { MachineCommandReportV1 } from "@frockbot/plugin-user-machine/device";
import type { MachineMessagesOpRunnerV1 } from "@frockbot/plugin-user-machine/device-runner";

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** One row of a `chat.db` read, as SQLite hands it back. */
export type MachineMessagesRowV1 = Record<string, string | number | null>;

export interface MachineMessagesQueryRequestV1 {
  sql: string;
  parameters: Array<string | number>;
  maxRows: number;
}

/**
 * The only authority a Messages call has over the Mac.
 *
 * Four verbs, and none of them takes a decision. `apps/desktop` implements it
 * with `node:sqlite`, `osascript` and `node:fs`; a plain object implements it
 * in a test, which is why every line above it runs in CI.
 */
export interface MachineMessagesDeviceSeamV1 {
  /** Whether macOS has granted Full Disk Access and Automation, right now. */
  checkPermissions(
    signal: AbortSignal,
  ): Promise<Omit<MachineMessagesPermissionsV1, "schemaVersion" | "checkedAt">>;
  /** One read-only `SELECT` against `~/Library/Messages/chat.db`. */
  query(
    request: MachineMessagesQueryRequestV1,
    signal: AbortSignal,
  ): Promise<MachineMessagesRowV1[]>;
  /** Tell Messages.app to send. The AppleScript is composed here, not there. */
  send(
    request: { recipient: string; text: string },
    signal: AbortSignal,
  ): Promise<void>;
  /** One attachment's bytes, bounded. */
  readFile(
    request: { path: string; maxBytes: number },
    signal: AbortSignal,
  ): Promise<{ bytesBase64: string; truncated: boolean }>;
  /** The user's home directory, so a `~`-relative attachment path resolves. */
  home(): string;
}

// ---------------------------------------------------------------------------
// chat.db
// ---------------------------------------------------------------------------

/** Where the Messages database lives, relative to a home directory. */
export function machineMessagesDatabasePathV1(home: string): string {
  return `${home.replace(/\/$/, "")}/Library/Messages/chat.db`;
}

/**
 * Apple's epoch is 2001-01-01, and `message.date` has been nanoseconds since
 * it for a decade — but rows written by very old macOS versions are seconds.
 * The magnitude tells them apart, which is cheaper and more honest than
 * guessing from an OS version the backend cannot see.
 */
export const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

export function appleDateToIsoV1(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) {
    return undefined;
  }
  const seconds = Math.abs(value) > 1e11 ? value / 1_000_000_000 : value;
  const at = (seconds + APPLE_EPOCH_OFFSET_SECONDS) * 1_000;
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) return undefined;
  return new Date(at).toISOString();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One conversation, as a tool result renders it. */
export interface MachineMessagesChatV1 {
  chatId: string;
  name?: string;
  handle?: string;
  lastMessageAt?: string;
}

export function machineMessagesChatRowV1(
  row: MachineMessagesRowV1,
): MachineMessagesChatV1 {
  return {
    chatId: String(row.guid ?? row.chat_identifier ?? row.ROWID ?? ""),
    ...(text(row.display_name) === undefined
      ? {}
      : { name: text(row.display_name)! }),
    ...(text(row.chat_identifier) === undefined
      ? {}
      : { handle: text(row.chat_identifier)! }),
    ...(appleDateToIsoV1(row.last_date) === undefined
      ? {}
      : { lastMessageAt: appleDateToIsoV1(row.last_date)! }),
  };
}

/** One message, as a tool result renders it. */
export interface MachineMessagesItemV1 {
  rowId: number;
  chatId?: string;
  fromMe: boolean;
  handle?: string;
  text?: string;
  at?: string;
  attachmentId?: string;
}

export function machineMessagesItemRowV1(
  row: MachineMessagesRowV1,
): MachineMessagesItemV1 {
  const rowId = typeof row.ROWID === "number" ? row.ROWID : 0;
  return {
    rowId,
    ...(text(row.chat_guid) === undefined
      ? {}
      : { chatId: text(row.chat_guid)! }),
    fromMe: row.is_from_me === 1,
    ...(text(row.handle) === undefined ? {} : { handle: text(row.handle)! }),
    ...(text(row.text) === undefined ? {} : { text: text(row.text)! }),
    ...(appleDateToIsoV1(row.date) === undefined
      ? {}
      : { at: appleDateToIsoV1(row.date)! }),
    ...(row.attachment_id === null || row.attachment_id === undefined
      ? {}
      : { attachmentId: String(row.attachment_id) }),
  };
}

const CHAT_COLUMNS =
  "c.ROWID AS ROWID, c.guid AS guid, c.chat_identifier AS chat_identifier, c.display_name AS display_name, MAX(m.date) AS last_date";

const MESSAGE_COLUMNS =
  "m.ROWID AS ROWID, m.text AS text, m.is_from_me AS is_from_me, m.date AS date, h.id AS handle, c.guid AS chat_guid, (SELECT attachment_id FROM message_attachment_join WHERE message_id = m.ROWID LIMIT 1) AS attachment_id";

/**
 * The statement one call runs, and its bound parameters.
 *
 * Exported because it is the interesting half: a test asserts the exact SQL and
 * the exact parameters, which is how "a Bot's text never becomes a query" is
 * checked rather than asserted.
 */
export function machineMessagesQueryV1(
  call: MachineMessagesCallV1,
): MachineMessagesQueryRequestV1 {
  if (call.kind === "find-chats") {
    const filter = call.query
      ? " WHERE c.display_name LIKE ?1 OR c.chat_identifier LIKE ?1"
      : "";
    return {
      sql: `SELECT ${CHAT_COLUMNS} FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id${filter} GROUP BY c.ROWID ORDER BY last_date DESC LIMIT ${call.limit}`,
      parameters: call.query ? [`%${call.query}%`] : [],
      maxRows: call.limit,
    };
  }
  if (call.kind === "chat-items") {
    const paging = call.beforeRowId === undefined ? "" : " AND m.ROWID < ?2";
    return {
      sql: `SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE (c.guid = ?1 OR c.chat_identifier = ?1)${paging} ORDER BY m.date DESC LIMIT ${call.limit}`,
      parameters:
        call.beforeRowId === undefined
          ? [call.chatId]
          : [call.chatId, call.beforeRowId],
      maxRows: call.limit,
    };
  }
  if (call.kind === "search") {
    return {
      sql: `SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.text LIKE ?1 ORDER BY m.date DESC LIMIT ${call.limit}`,
      parameters: [`%${call.query}%`],
      maxRows: call.limit,
    };
  }
  if (call.kind === "activity") {
    return {
      sql: `SELECT ${MESSAGE_COLUMNS} FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id LEFT JOIN handle h ON h.ROWID = m.handle_id ORDER BY m.date DESC LIMIT ${call.limit}`,
      parameters: [],
      maxRows: call.limit,
    };
  }
  if (call.kind === "fetch-attachment") {
    return {
      sql: "SELECT a.ROWID AS ROWID, a.guid AS guid, a.filename AS filename, a.mime_type AS mime_type, a.total_bytes AS total_bytes FROM attachment a WHERE CAST(a.ROWID AS TEXT) = ?1 OR a.guid = ?1 LIMIT 1",
      parameters: [call.attachmentId],
      maxRows: 1,
    };
  }
  throw new Error(`${call.kind} is not a chat.db read`);
}

/** `~/…` as `chat.db` stores it, resolved against the agent's own home. */
export function machineMessagesAttachmentPathV1(
  filename: string,
  home: string,
): string {
  if (filename.startsWith("~/")) {
    return `${home.replace(/\/$/, "")}/${filename.slice(2)}`;
  }
  return filename;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * AppleScript has no parameter binding, so the escape is the whole safety
 * story: a double quote or a backslash in somebody's message must not be able
 * to close the string and become script. Everything else — including a newline,
 * which AppleScript string literals accept — is left exactly as the user wrote
 * it, because a send that silently rewrote the message would be worse than one
 * that refused.
 */
export function escapeAppleScriptStringV1(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The script one send runs. Composed here so its escaping is tested here. */
export function machineMessagesSendScriptV1(
  recipient: string,
  body: string,
): string {
  return [
    'tell application "Messages"',
    "  set targetService to 1st account whose service type = iMessage",
    `  set targetBuddy to participant "${escapeAppleScriptStringV1(recipient)}" of targetService`,
    `  send "${escapeAppleScriptStringV1(body)}" to targetBuddy`,
    "end tell",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface MachineMessagesDeviceRunnerOptionsV1 {
  seam: MachineMessagesDeviceSeamV1;
  now?(): number;
}

/**
 * The refusal wording, once. "Refused:" is load-bearing — `plugin-audit`'s
 * `outcomeFor` classifies on that prefix, so a permission the user never
 * granted reads as a decision rather than a failure of their Mac.
 */
export function machineMessagesRefusalV1(reason: string): string {
  return `Refused: ${reason}`;
}

export const MACHINE_MESSAGES_FULL_DISK_REFUSAL_V1 =
  "macOS has not granted FrockBot Full Disk Access on this Mac, so Messages history cannot be read. Grant it in System Settings › Privacy & Security › Full Disk Access and restart FrockBot.";

export const MACHINE_MESSAGES_AUTOMATION_REFUSAL_V1 =
  "macOS has not granted FrockBot Automation rights over Messages.app on this Mac, so nothing can be sent. Grant it in System Settings › Privacy & Security › Automation.";

/**
 * One Messages call, run.
 *
 * Never throws: a thrown handler would leave a claimed command unanswered until
 * its lease lapsed, and an `error` outcome a Bot can read is strictly better
 * than silence.
 */
export function createMachineMessagesDeviceRunnerV1(
  options: MachineMessagesDeviceRunnerOptionsV1,
): MachineMessagesOpRunnerV1 {
  const at = (): string =>
    new Date(options.now?.() ?? Date.now()).toISOString();
  const refuse = (reason: string): MachineCommandReportV1 => ({
    finishedAt: at(),
    outcome: "refused",
    truncated: false,
    message: machineMessagesRefusalV1(reason).slice(
      0,
      MACHINE_LIMITS_V1.message,
    ),
  });
  const ok = (
    body: Record<string, unknown>,
    extra: Partial<MachineCommandReportV1> = {},
  ): MachineCommandReportV1 => ({
    finishedAt: at(),
    outcome: "ok",
    truncated: false,
    stdout: JSON.stringify(body),
    ...extra,
  });

  return async (call, signal) => {
    try {
      const observed = await options.seam.checkPermissions(signal);
      const permissions: MachineMessagesPermissionsV1 = {
        schemaVersion: 1,
        fullDiskAccess: observed.fullDiskAccess,
        automation: observed.automation,
        checkedAt: at(),
        ...(observed.detail === undefined
          ? {}
          : {
              detail: observed.detail.slice(
                0,
                MACHINE_MESSAGES_LIMITS_V1.detail,
              ),
            }),
      };
      // The check itself always answers. It is how a machine stops being
      // unknown to the backend, so refusing it for want of a permission would
      // be a gate that can never be opened.
      if (call.kind === "check-permissions") {
        return ok({ kind: "permissions", permissions });
      }
      if (!permissions.fullDiskAccess) {
        return refuse(MACHINE_MESSAGES_FULL_DISK_REFUSAL_V1);
      }
      if (call.kind === "send") {
        if (!permissions.automation) {
          return refuse(MACHINE_MESSAGES_AUTOMATION_REFUSAL_V1);
        }
        await options.seam.send(
          { recipient: call.to, text: call.text },
          signal,
        );
        return ok({ kind: "sent", to: call.to, at: at() });
      }
      const rows = await options.seam.query(
        machineMessagesQueryV1(call),
        signal,
      );
      if (call.kind === "find-chats") {
        return ok({
          kind: "chats",
          chats: rows.map((row) => machineMessagesChatRowV1(row)),
        });
      }
      if (call.kind === "fetch-attachment") {
        const row = rows[0];
        const filename = row === undefined ? undefined : text(row.filename);
        if (!filename) {
          return refuse(
            `no attachment "${call.attachmentId}" is in this Mac's Messages database`,
          );
        }
        const file = await options.seam.readFile(
          {
            path: machineMessagesAttachmentPathV1(
              filename,
              options.seam.home(),
            ),
            maxBytes: call.maxBytes,
          },
          signal,
        );
        return ok(
          {
            kind: "attachment",
            attachmentId: call.attachmentId,
            ...(text(row?.mime_type) === undefined
              ? {}
              : { mimeType: text(row?.mime_type)! }),
            truncated: file.truncated,
          },
          { truncated: file.truncated, bytesBase64: file.bytesBase64 },
        );
      }
      return ok({
        kind: "items",
        items: rows.map((row) => machineMessagesItemRowV1(row)),
      });
    } catch (error) {
      return {
        finishedAt: at(),
        outcome: "error",
        truncated: false,
        message: (error instanceof Error ? error.message : String(error)).slice(
          0,
          MACHINE_LIMITS_V1.message,
        ),
      };
    }
  };
}
