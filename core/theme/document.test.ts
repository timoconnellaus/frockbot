import { describe, expect, test } from "bun:test";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
  ThemeDocumentDecodeError,
  compileBotLookV1,
  contrastRatioV1,
  decodeThemeDocumentV1,
  namedLookDocumentV1,
  resolveAccountLookV1,
  resolveThemeTokensV1,
  tokensMeetContrastFloorV1,
} from "./document.js";

describe("named looks", () => {
  test("Ink, Paper and Studio each meet the contrast floor", () => {
    for (const document of [
      INK_DOCUMENT_V1,
      PAPER_DOCUMENT_V1,
      STUDIO_DOCUMENT_V1,
    ]) {
      expect(tokensMeetContrastFloorV1(document.tokens)).toBe(true);
      expect(decodeThemeDocumentV1(document)).toEqual(document);
    }
  });

  test("Inherit compiles the account look; Studio is its own document", () => {
    expect(compileBotLookV1("inherit", "paper", true).look).toBe("paper");
    expect(compileBotLookV1("inherit", "system", true).look).toBe("ink");
    expect(compileBotLookV1("inherit", "system", false).look).toBe("paper");
    expect(compileBotLookV1("studio", "ink", true)).toEqual(
      namedLookDocumentV1("studio"),
    );
  });

  test("System follows the OS", () => {
    expect(resolveAccountLookV1("system", true)).toBe("ink");
    expect(resolveAccountLookV1("system", false)).toBe("paper");
    expect(resolveAccountLookV1("ink", false)).toBe("ink");
  });
});

describe("ThemeDocument decoding", () => {
  test("refuses forbidden keys anywhere in the tree", () => {
    for (const key of ["approval", "billing", "Stop", "grants"]) {
      expect(() =>
        decodeThemeDocumentV1({
          ...INK_DOCUMENT_V1,
          [key]: true,
        }),
      ).toThrow(ThemeDocumentDecodeError);
    }
  });

  test("refuses unknown fields and a failing contrast floor", () => {
    expect(() =>
      decodeThemeDocumentV1({ ...INK_DOCUMENT_V1, extra: true }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeThemeDocumentV1({
        ...INK_DOCUMENT_V1,
        tokens: {
          ...INK_DOCUMENT_V1.tokens,
          surfaces: {
            ...INK_DOCUMENT_V1.tokens.surfaces,
            text: "#1f1e24",
          },
        },
      }),
    ).toThrow(/contrast floor/);
  });

  test("normalises colours to lowercase #rrggbb", () => {
    const decoded = decodeThemeDocumentV1({
      ...INK_DOCUMENT_V1,
      tokens: {
        ...INK_DOCUMENT_V1.tokens,
        surfaces: {
          ...INK_DOCUMENT_V1.tokens.surfaces,
          accent: "#D03F64",
        },
      },
    });
    expect(decoded.tokens.surfaces.accent).toBe("#d03f64");
  });
});

describe("phases", () => {
  test("picks the latest phase whose after is at or before now", () => {
    const dusk = {
      ...PAPER_DOCUMENT_V1.tokens,
      surfaces: {
        ...PAPER_DOCUMENT_V1.tokens.surfaces,
        accent: "#9c1a44",
      },
    };
    const document = decodeThemeDocumentV1({
      ...PAPER_DOCUMENT_V1,
      phases: [
        { after: "07:00", tokens: PAPER_DOCUMENT_V1.tokens },
        { after: "19:00", tokens: dusk },
      ],
    });
    expect(
      resolveThemeTokensV1(
        document,
        new Date("2026-09-18T08:30:00.000Z"),
        "UTC",
      ).surfaces.accent,
    ).toBe("#c23359");
    expect(
      resolveThemeTokensV1(
        document,
        new Date("2026-09-18T20:15:00.000Z"),
        "UTC",
      ).surfaces.accent,
    ).toBe("#9c1a44");
    expect(
      resolveThemeTokensV1(
        document,
        new Date("2026-09-18T04:00:00.000Z"),
        "UTC",
      ).surfaces.accent,
    ).toBe("#9c1a44");
  });
});

describe("contrast", () => {
  test("Ink text on its window is well above 4.5:1", () => {
    expect(
      contrastRatioV1(
        INK_DOCUMENT_V1.tokens.surfaces.text,
        INK_DOCUMENT_V1.tokens.surfaces.window,
      ),
    ).toBeGreaterThan(4.5);
  });
});
