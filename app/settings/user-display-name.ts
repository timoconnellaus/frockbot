import {
  isChosenUserName,
  unnamedUserDisplayNameV1,
} from "@frockbot/core/configuration";

export function resolveUserDisplayName(input: {
  savedName?: string;
  sessionName?: string;
  sessionEmail?: string;
  productName: string;
}): string {
  if (isChosenUserName(input.savedName)) return input.savedName.trim();
  if (isChosenUserName(input.sessionName)) return input.sessionName.trim();

  const sessionEmail = input.sessionEmail?.trim();
  return sessionEmail || unnamedUserDisplayNameV1(input.productName);
}
