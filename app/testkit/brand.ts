import type { BrandV1 } from "@frockbot/core/contracts";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "@frockbot/core/theme";

/**
 * The brand a suite runs app code with: FrockBot's words, so a test reads
 * what the hosted deployment shows. The Worker's own brand is `#brand`, which
 * app code never imports; this one carries a one-pixel logo, not FrockBot's.
 */
export const TEST_BRAND_V1: BrandV1 = {
  schemaVersion: 1,
  productName: "FrockBot",
  homepage: "https://frockbot.com",
  builtInModelName: "Frock AI",
  emailSenderName: "FrockBot",
  iconPng: "./icon.png",
  pageLogo:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  looks: {
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  },
  whatsNew: true,
};
