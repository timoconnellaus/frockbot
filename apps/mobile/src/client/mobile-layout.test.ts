import { describe, expect, test } from "bun:test";
import capacitorConfig from "../../capacitor.config.ts";

declare const Bun: {
  file(path: URL): { text(): Promise<string> };
};

const stylesheetUrl = new URL("./mobile.css", import.meta.url);

type CssDeclarations = Map<string, Map<string, string>>;

function parseCssDeclarations(stylesheet: string): CssDeclarations {
  const rules: CssDeclarations = new Map();
  for (const match of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const declaration of match[2]?.split(";") ?? []) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      declarations.set(
        declaration.slice(0, separator).trim(),
        declaration
          .slice(separator + 1)
          .trim()
          .replace(/\s+/g, ""),
      );
    }
    for (const selector of match[1]?.split(",") ?? []) {
      rules.set(selector.trim(), declarations);
    }
  }
  return rules;
}

async function mobileRules(): Promise<CssDeclarations> {
  return parseCssDeclarations(await Bun.file(stylesheetUrl).text());
}

describe("mobile safe-area layout", () => {
  test("prefers native insets and falls back to browser safe areas", async () => {
    const root = (await mobileRules()).get(":root");

    expect(capacitorConfig.plugins?.SystemBars).toMatchObject({
      insetsHandling: "css",
    });
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(root?.get(`--mobile-safe-${edge}`)).toBe(
        `var(--safe-area-inset-${edge},env(safe-area-inset-${edge},0px))`,
      );
    }
  });

  test.each([".mobile-root", ".mobile-auth"])(
    "%s keeps safe-area padding inside the visible viewport",
    async (selector: string) => {
      const declarations = (await mobileRules()).get(selector);

      expect(declarations?.get("height")).toBe("100dvh");
      expect(declarations?.get("box-sizing")).toBe("border-box");
      expect(declarations?.get("padding")).toContain("var(--mobile-safe-top)");
      expect(declarations?.get("padding")).toContain(
        "var(--mobile-safe-right)",
      );
      expect(declarations?.get("padding")).toContain(
        "var(--mobile-safe-bottom)",
      );
      expect(declarations?.get("padding")).toContain("var(--mobile-safe-left)");
    },
  );
});
