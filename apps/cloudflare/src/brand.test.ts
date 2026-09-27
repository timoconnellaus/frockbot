import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBrandV1 } from "@frockbot/core/contracts";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "@frockbot/core/theme";
import { BRAND_V1 } from "#brand";

test("the tracked brand is FrockBot's, and valid", () => {
  expect(decodeBrandV1(BRAND_V1)).toEqual(BRAND_V1);
  expect(BRAND_V1.productName).toBe("FrockBot");
  expect(BRAND_V1.builtInModelName).toBe("Frock AI");
  expect(BRAND_V1.whatsNew).toBe(true);
  // The palettes every client already paints: the brand changes nothing.
  expect(BRAND_V1.looks).toEqual({
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  });
});

test("its icon is the one the site already served", () => {
  // Inside the package, so a consumer's install has it; the same bytes as the
  // canonical marketing icon, so the hosted document's icon is unchanged.
  const icon = fileURLToPath(new URL(BRAND_V1.iconPng, import.meta.url));
  const canonical = fileURLToPath(
    new URL(
      "../../../assets/marketing/app-icon/frockbot-icon-64.png",
      import.meta.url,
    ),
  );
  expect(new Uint8Array(readFileSync(icon))).toEqual(
    new Uint8Array(readFileSync(canonical)),
  );
});
