/**
 * FrockBot's brand: what the hosted deployment and every suite show a person.
 *
 * The Worker reaches it through `#brand`, which `apps/cloudflare/package.json`
 * maps here. A profile that names its own brand module gets a generated
 * wrangler config aliasing `#brand` to that file instead, the way `access`
 * profiles alias `#auth-package` ([ADR 0038](../../../docs/adr/0038-white-label-deployments.md)).
 * Only the Worker imports this; app code is handed the brand as data.
 */
import type { BrandV1 } from "@frockbot/core/contracts";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "@frockbot/core/theme";
import { FROCKBOT_PAGE_LOGO_V1 } from "./brand-logo.js";

export const BRAND_V1: BrandV1 = {
  schemaVersion: 1,
  productName: "FrockBot",
  homepage: "https://frockbot.com",
  builtInModelName: "Frock AI",
  emailSenderName: "FrockBot",
  // A copy of the canonical `assets/marketing/app-icon/frockbot-icon-64.png`,
  // kept inside the package so the published `@frockbot/cloudflare` builds
  // its default brand too; `brand.test.ts` holds the two to the same bytes.
  iconPng: "./brand-icon.png",
  pageLogo: FROCKBOT_PAGE_LOGO_V1,
  nativeScheme: "frockbot",
  looks: {
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  },
  whatsNew: true,
};
