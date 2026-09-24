// What a `ConnectApp` on a Card connects (ADR 0030).
//
// A Bot that cannot reach an app offers it: "there is a Gmail connector —
// want to connect it?" The card names the app and the host draws the button,
// which starts the same hosted grant the Marketplace's Connect does, under the
// person's own session. Pressing it is the User granting; drawing it is only
// the Bot proposing. So the name beside the button, and the Connection Type it
// starts, are this catalog's answer to what the Bot wrote, never the Bot's.
import type { CardConnectAppV1 } from "@frockbot/app/shell/cards";
import {
  CONNECT_PACKAGE_ID,
  connectConnectionTypeIdV1,
  findConnectToolkitV1,
} from "./catalog.js";

/** The app one `ConnectApp` names, or the sentence the refused send carries. */
export function connectCardAppV1(named: string): CardConnectAppV1 | string {
  const found = findConnectToolkitV1(named);
  if ("toolkit" in found) {
    const { slug, name, description } = found.toolkit;
    return {
      app: slug,
      name,
      description,
      packageId: CONNECT_PACKAGE_ID,
      connectionTypeId: connectConnectionTypeIdV1(slug),
    };
  }
  const missing = `no app "${named.slice(0, 100)}" is in the Marketplace`;
  if (found.closest.length === 0) return missing;
  return `${missing}; the closest are ${found.closest
    .map((toolkit) => `${toolkit.name} ("${toolkit.slug}")`)
    .join(", ")}`;
}
