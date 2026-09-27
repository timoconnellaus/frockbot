// A brand another product would name from its profile, for the generator's
// tests: FrockBot's palettes under other words, with What's New off.
import type { BrandV1 } from "../../../../core/contracts/brand.ts";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "../../../../core/theme/index.ts";

export const BRAND_V1: BrandV1 = {
  schemaVersion: 1,
  productName: "Wallet Pal",
  builtInModelName: "Pal AI",
  emailSenderName: "Wallet Pal",
  iconPng: "../../../../assets/marketing/app-icon/frockbot-icon-64.png",
  looks: {
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  },
  whatsNew: false,
};
