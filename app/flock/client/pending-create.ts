import {
  decodeCreateBotCommandV1,
  decodeUpdateSheepCommandV1,
  type CreateBotCommandV1,
  type UpdateSheepCommandV1,
} from "../shared.js";

export const PENDING_CREATE_KEY = "frockbot.flock.pending-create.v1";
export const PENDING_SHEEP_KEY = "frockbot.flock.pending-sheep.v1";

export function pendingCreateKey(userId: string): string {
  return `${PENDING_CREATE_KEY}:${encodeURIComponent(userId)}`;
}

export function pendingSheepKey(userId: string, botId: string): string {
  return `${PENDING_SHEEP_KEY}:${encodeURIComponent(userId)}:${encodeURIComponent(botId)}`;
}

export function readPendingCreate(
  userId: string,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): CreateBotCommandV1 | undefined {
  const key = pendingCreateKey(userId);
  const value = storage.getItem(key);
  if (!value) return undefined;
  try {
    return decodeCreateBotCommandV1(JSON.parse(value));
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function writePendingCreate(
  userId: string,
  command: CreateBotCommandV1,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(pendingCreateKey(userId), JSON.stringify(command));
}

export function clearPendingCreate(
  userId: string,
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  storage.removeItem(pendingCreateKey(userId));
}

export function readPendingSheep(
  userId: string,
  botId: string,
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
): UpdateSheepCommandV1 | undefined {
  const key = pendingSheepKey(userId, botId);
  const value = storage.getItem(key);
  if (!value) return undefined;
  try {
    const command = decodeUpdateSheepCommandV1(JSON.parse(value));
    if (command.botId !== botId) throw new Error("pending Bot mismatch");
    return command;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
}

export function writePendingSheep(
  userId: string,
  command: UpdateSheepCommandV1,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(
    pendingSheepKey(userId, command.botId),
    JSON.stringify(command),
  );
}

export function clearPendingSheep(
  userId: string,
  botId: string,
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  storage.removeItem(pendingSheepKey(userId, botId));
}

export function isDefinitiveFlockFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "definitive" in error &&
    error.definitive === true
  );
}
