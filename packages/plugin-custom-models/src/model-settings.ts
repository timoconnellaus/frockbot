import {
  decodeModelBindingV1,
  type ModelBindingV1,
} from "@frockbot/configuration-core";

export const ACCOUNT_MODEL_SETTING_ID_V1 = "account-model";
export const BOT_MODEL_SETTING_ID_V1 = "model";

/** A model-role value has already crossed a decoded settings seam; be defensive when reading an absent or stale value. */
export function storedModelBindingV1(
  value: unknown,
): ModelBindingV1 | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeModelBindingV1(value);
  } catch {
    return undefined;
  }
}
