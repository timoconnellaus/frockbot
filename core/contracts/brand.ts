/**
 * What a person sees of the product: its words, its icon and its looks.
 *
 * A brand is chosen at build time, the way the auth Package is: the Worker
 * imports `#brand`, which resolves to FrockBot's own
 * (`apps/cloudflare/src/brand.ts`) unless a deployment profile names another
 * module ([ADR 0038](../../docs/adr/0038-white-label-deployments.md)). App code
 * never imports it; the Worker entry hands it over as data.
 *
 * Where a deployment runs and which native apps sign in to it are the
 * profile's, not the brand's. Trust chrome is neither: a brand names no
 * approval, billing or Stop surface, exactly as a ThemeDocument names none.
 */
import {
  decodeThemeDocumentV1,
  NAMED_LOOKS_V1,
  type NamedLookDocumentsV1,
  type NamedLookV1,
  type ThemeDocumentV1,
} from "../theme/index.js";

export interface BrandV1 {
  schemaVersion: 1;
  /** The product's name wherever a person reads it. */
  productName: string;
  /** The built-in model's display name. */
  builtInModelName: string;
  /**
   * The product's public https home, which outbound requests that identify
   * themselves point back to (a fetched page sees it in the user agent).
   */
  homepage: string;
  /** The display name mail is sent under when nothing more specific names it. */
  emailSenderName: string;
  /**
   * The icon the web document and email use: a PNG, as a path relative to the
   * brand module. The artifact build reads it and embeds the bytes.
   */
  iconPng: string;
  /**
   * The logo the pages a browser lands on show — sign-in, returns, connected
   * apps — inlined as a `data:image/…;base64,` URL, because those pages load
   * nothing from anywhere.
   */
  pageLogo: string;
  /** The palette behind each named look. */
  looks: NamedLookDocumentsV1;
  /**
   * Whether What's New is served. Its entries are FrockBot's release notes,
   * so another product turns it off rather than inheriting them.
   */
  whatsNew: boolean;
}

export class BrandDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandDecodeError";
  }
}

const BRAND_KEYS_V1 = [
  "schemaVersion",
  "productName",
  "builtInModelName",
  "homepage",
  "emailSenderName",
  "iconPng",
  "pageLogo",
  "looks",
  "whatsNew",
] as const;

function name(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 80 ||
    /[\p{Cc}\p{Cf}<>]/u.test(value)
  ) {
    throw new BrandDecodeError(`brand.${label} must be a short plain name`);
  }
  return value;
}

/**
 * The brand, validated. Every look passes the ThemeDocument decoder, so the
 * contrast floor and the forbidden trust-chrome keys hold for a brand's
 * palettes exactly as they hold for a Plugin's theme.
 */
export function decodeBrandV1(input: unknown): BrandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrandDecodeError("brand must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== BRAND_KEYS_V1.length ||
    !BRAND_KEYS_V1.every((key) => Object.hasOwn(value, key))
  ) {
    throw new BrandDecodeError(
      `brand must carry exactly ${BRAND_KEYS_V1.join(", ")}`,
    );
  }
  if (value.schemaVersion !== 1) {
    throw new BrandDecodeError("unsupported brand");
  }
  if (
    typeof value.homepage !== "string" ||
    !/^https:\/\/[a-z0-9.-]+(\/[^\s"<>]*)?$/.test(value.homepage)
  ) {
    throw new BrandDecodeError("brand.homepage must be an https URL");
  }
  if (typeof value.iconPng !== "string" || !value.iconPng.endsWith(".png")) {
    throw new BrandDecodeError("brand.iconPng must name a .png file");
  }
  if (
    typeof value.pageLogo !== "string" ||
    !/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(
      value.pageLogo,
    )
  ) {
    throw new BrandDecodeError(
      "brand.pageLogo must be a base64 PNG, WebP or JPEG data URL",
    );
  }
  if (typeof value.whatsNew !== "boolean") {
    throw new BrandDecodeError("brand.whatsNew must be true or false");
  }
  const looks = value.looks;
  if (!looks || typeof looks !== "object" || Array.isArray(looks)) {
    throw new BrandDecodeError("brand.looks must be an object");
  }
  const lookEntries = looks as Record<string, unknown>;
  if (
    Object.keys(lookEntries).length !== NAMED_LOOKS_V1.length ||
    !NAMED_LOOKS_V1.every((look) => Object.hasOwn(lookEntries, look))
  ) {
    throw new BrandDecodeError(
      `brand.looks must carry exactly ${NAMED_LOOKS_V1.join(", ")}`,
    );
  }
  const decoded = {} as Record<NamedLookV1, ThemeDocumentV1>;
  for (const look of NAMED_LOOKS_V1) {
    let document: ThemeDocumentV1;
    try {
      document = decodeThemeDocumentV1(lookEntries[look]);
    } catch (error) {
      throw new BrandDecodeError(
        `brand.looks.${look}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (document.look !== look) {
      throw new BrandDecodeError(
        `brand.looks.${look} is a ${document.look} look`,
      );
    }
    decoded[look] = document;
  }
  return {
    schemaVersion: 1,
    productName: name(value.productName, "productName"),
    builtInModelName: name(value.builtInModelName, "builtInModelName"),
    homepage: value.homepage,
    emailSenderName: name(value.emailSenderName, "emailSenderName"),
    iconPng: value.iconPng,
    pageLogo: value.pageLogo,
    looks: decoded,
    whatsNew: value.whatsNew,
  };
}

/**
 * How the product identifies itself to a server it calls: an RFC 9110 product
 * token — the name with anything a token cannot carry left out — and its home.
 */
export function brandUserAgentV1(
  brand: Pick<BrandV1, "productName" | "homepage">,
): string {
  const token = brand.productName.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, "");
  return `${token || "Bot"}/0.0.1 (+${brand.homepage})`;
}
