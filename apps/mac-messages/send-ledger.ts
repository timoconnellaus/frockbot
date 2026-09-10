import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeMachineCommandResultV1 } from "@frockbot/core/machine-protocol";
import type { MachineCommandRunnerV1 } from "@frockbot/app/machine/device";

/** A claimed command can be delivered again after its cloud lease expires. */
export function withSendLedger(
  path: string,
  runner: MachineCommandRunnerV1,
): MachineCommandRunnerV1 {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sends (command_id TEXT PRIMARY KEY, result TEXT)",
  );
  return {
    async run(command, signal) {
      if (command.op.kind !== "messages" || command.op.call.kind !== "send")
        return runner.run(command, signal);
      signal.throwIfAborted();
      const admitted =
        db
          .query("INSERT OR IGNORE INTO sends (command_id) VALUES (?)")
          .run(command.commandId).changes === 1;
      if (!admitted) {
        const row = db
          .query<{ result: string | null }, [string]>(
            "SELECT result FROM sends WHERE command_id = ?",
          )
          .get(command.commandId);
        if (row?.result) {
          const {
            schemaVersion: _,
            commandId: __,
            ...report
          } = decodeMachineCommandResultV1(JSON.parse(row.result));
          return report;
        }
        return {
          finishedAt: new Date().toISOString(),
          outcome: "refused",
          truncated: false,
          message:
            "Refused: this send was already attempted and its outcome is unknown. Check Messages before approving a new send; FrockBot will not send it again.",
        };
      }
      // Commit intent before Apple Events. A crash between intent and receipt is
      // unknown, never permission to repeat an externally visible send.
      const report = await runner.run(command, signal);
      db.query("UPDATE sends SET result = ? WHERE command_id = ?").run(
        JSON.stringify({
          schemaVersion: 1,
          commandId: command.commandId,
          ...report,
        }),
        command.commandId,
      );
      return report;
    },
  };
}
