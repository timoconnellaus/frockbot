/**
 * The names a suite builds the Packages with: FrockBot's, so a test reads what
 * the hosted deployment shows. The Worker's own brand is `#brand`, which app
 * code never imports.
 */
export const TEST_BRAND_NAMES_V1 = {
  productName: "FrockBot",
  builtInModelName: "Frock AI",
} as const;
