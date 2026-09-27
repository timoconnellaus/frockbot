// The white-label's own brand, which its profile names and the generator
// aliases `#brand` to. Imported from the published packages, as a white-label
// repository would.
import type { BrandV1 } from "@frockbot/core/contracts";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "@frockbot/core/theme";

export const BRAND_V1: BrandV1 = {
  schemaVersion: 1,
  productName: "Wallet Pal",
  homepage: "https://wallet-pal.example",
  builtInModelName: "Pal AI",
  emailSenderName: "Wallet Pal",
  iconPng: "./icon.png",
  pageLogo: "data:image/png;base64,V2FsbGV0UGFs",
  nativeScheme: "walletpal",
  looks: {
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  },
  whatsNew: false,
};
