import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import {
  type ConnectionDependencyResultV1,
  type ConnectionDependencyRouter,
  decodeConnectionDependencyCommandV1,
} from "@frockbot/connection-core";

/** Selects a Connection Contribution only from the durable Connection's Package. */
export function executeUserConnectionDependency(
  settings: UserSettingsViewV1,
  router: ConnectionDependencyRouter,
  input: unknown,
): Promise<ConnectionDependencyResultV1> {
  const command = decodeConnectionDependencyCommandV1(input);
  const connection = settings.connections.find(
    (candidate) => candidate.connectionId === command.connectionId,
  );
  if (connection && connection.packageId !== command.packageId) {
    return Promise.resolve({
      schemaVersion: 1,
      status: "rejected",
      failure: `Connection "${command.connectionId}" does not belong to Package "${command.packageId}"`,
    });
  }
  if (
    command.action === "claim" &&
    (!connection || connection.state !== "ready")
  ) {
    return Promise.resolve({
      schemaVersion: 1,
      status: "unavailable",
      failure: `Connection "${command.connectionId}" is unavailable`,
    });
  }
  return router.execute(command.packageId, command);
}
