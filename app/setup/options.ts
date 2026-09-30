import type { SetupOptionsV1 } from "@frockbot/core/setup-choices";
import { SETUP_OPTIONS_V1 } from "./options.generated.js";

/**
 * What the setup chooser on frockbot.com offers, and whether each option can
 * be used yet: `apps/marketing/content/setup-options.json` with each catalog
 * provider's models filled in, generated here by that site's build. A status
 * flipped to available there is flipped for the app's review too.
 */
export function setupOptionsV1(): SetupOptionsV1 {
  return SETUP_OPTIONS_V1;
}
