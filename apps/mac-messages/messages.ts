import { Database } from "bun:sqlite";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  machineMessagesDatabasePathV1,
  machineMessagesSendScriptV1,
  type MachineMessagesDeviceSeamV1,
} from "@frockbot/app/machine-messages/device";

export interface NativeMessages {
  permissions(): Promise<boolean>;
  send(script: string): Promise<void>;
}

export function messagesSeam(
  home: string,
  native: NativeMessages,
): MachineMessagesDeviceSeamV1 {
  const database = machineMessagesDatabasePathV1(home);
  return {
    home: () => home,
    async checkPermissions(signal) {
      signal.throwIfAborted();
      let fullDiskAccess = false;
      try {
        const db = new Database(database, { readonly: true });
        try {
          db.query("SELECT ROWID FROM message LIMIT 1").all();
          fullDiskAccess = true;
        } finally {
          db.close();
        }
      } catch {
        /* The database may be absent or access may be denied. */
      }
      const automation = await native.permissions();
      return {
        fullDiskAccess,
        automation,
        ...(!fullDiskAccess
          ? {
              detail:
                "Messages history is unavailable. Sign in to Messages and grant FrockBot Full Disk Access, then reopen FrockBot.",
            }
          : {}),
      };
    },
    async query(request, signal) {
      signal.throwIfAborted();
      const db = new Database(database, { readonly: true });
      try {
        return db
          .query(request.sql)
          .all(...request.parameters)
          .slice(0, request.maxRows) as Array<
          Record<string, string | number | null>
        >;
      } finally {
        db.close();
      }
    },
    async send(request, signal) {
      signal.throwIfAborted();
      await native.send(
        machineMessagesSendScriptV1(request.recipient, request.text),
      );
    },
    async readFile(request, signal) {
      signal.throwIfAborted();
      // A database row must not turn an attachment request into arbitrary file access.
      const root = await realpath(join(home, "Library/Messages/Attachments"));
      const path = await realpath(request.path);
      if (!path.startsWith(root + sep))
        throw new Error("Attachment is outside Messages attachments");
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Attachment is not a regular file");
        const buffer = Buffer.alloc(Math.min(stat.size, request.maxBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        signal.throwIfAborted();
        return {
          bytesBase64: buffer.subarray(0, bytesRead).toString("base64"),
          truncated: stat.size > bytesRead,
        };
      } finally {
        await file.close();
      }
    },
  };
}
