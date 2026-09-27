import { describe, expect, test } from "bun:test";
import {
  INK_DOCUMENT_V1,
  PAPER_DOCUMENT_V1,
  STUDIO_DOCUMENT_V1,
} from "../theme/index.js";
import { BrandDecodeError, decodeBrandV1, type BrandV1 } from "./brand.js";

const brand: BrandV1 = {
  schemaVersion: 1,
  productName: "Wallet Pal",
  builtInModelName: "Pal AI",
  emailSenderName: "Wallet Pal",
  iconPng: "./icon.png",
  looks: {
    ink: INK_DOCUMENT_V1,
    paper: PAPER_DOCUMENT_V1,
    studio: STUDIO_DOCUMENT_V1,
  },
  whatsNew: false,
};

describe("a brand", () => {
  test("decodes to itself", () => {
    expect(decodeBrandV1(brand)).toEqual(brand);
  });

  test("cannot ship an unreadable look", () => {
    const unreadable = structuredClone(brand) as unknown as {
      looks: { paper: { tokens: { surfaces: { text: string } } } };
    };
    unreadable.looks.paper.tokens.surfaces.text = "#f5f6f9";
    expect(() => decodeBrandV1(unreadable)).toThrow(/contrast floor/);
  });

  test("names no trust chrome, in a look or beside one", () => {
    const inLook = structuredClone(brand) as unknown as {
      looks: { ink: Record<string, unknown> };
    };
    inLook.looks.ink.approval = { accent: "#000000" };
    expect(() => decodeBrandV1(inLook)).toThrow(/approval/);
    expect(() => decodeBrandV1({ ...brand, billing: "hidden" })).toThrow(
      BrandDecodeError,
    );
  });

  test("puts each palette behind its own look", () => {
    expect(() =>
      decodeBrandV1({
        ...brand,
        looks: { ...brand.looks, ink: PAPER_DOCUMENT_V1 },
      }),
    ).toThrow(/paper look/);
    const { studio: _studio, ...missing } = brand.looks;
    expect(() => decodeBrandV1({ ...brand, looks: missing })).toThrow(
      /ink, paper, studio/,
    );
  });

  test("is words a page can print as they are", () => {
    for (const productName of [
      "",
      " Pal",
      "<b>Pal</b>",
      "Pal\n",
      "x".repeat(81),
    ]) {
      expect(() => decodeBrandV1({ ...brand, productName })).toThrow(
        /productName/,
      );
    }
    expect(() => decodeBrandV1({ ...brand, iconPng: "./icon.svg" })).toThrow(
      /iconPng/,
    );
  });
});
