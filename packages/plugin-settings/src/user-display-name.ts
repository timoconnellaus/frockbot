import {
  isChosenUserName,
  USER_PROFILE_PLACEHOLDER_NAME_V1,
} from "@frockbot/configuration-core";

export function resolveUserDisplayName(input: {
  savedName?: string;
  sessionName?: string;
  sessionEmail?: string;
}): string {
  if (isChosenUserName(input.savedName)) return input.savedName.trim();
  if (isChosenUserName(input.sessionName)) return input.sessionName.trim();

  const sessionEmail = input.sessionEmail?.trim();
  return sessionEmail || USER_PROFILE_PLACEHOLDER_NAME_V1;
}
