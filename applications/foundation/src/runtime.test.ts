import { describe, expect, test } from "bun:test";
import {
  compileFoundationApplication,
  createFoundationRuntimeApplication,
} from "./runtime.js";

describe("foundation application", () => {
  test("compiles one deterministic package graph for every contribution kind", async () => {
    const first = await compileFoundationApplication();
    const second = await compileFoundationApplication();

    expect(first.applicationHash).toBe(second.applicationHash);
    expect(first.packages.map((pkg) => pkg.id)).toEqual([
      "auth",
      "clock",
      "desktop-clipboard",
      "desktop-directory-picker",
      "desktop-notifications",
      "echo",
      "fly-sprite",
      "identity",
      "memory",
      "provider-foundation",
      "shell",
    ]);
    expect(first.contributions).toEqual({
      runtime: [
        "clock",
        "echo",
        "fly-sprite",
        "identity",
        "memory",
        "provider-foundation",
      ],
      client: ["auth", "clock", "fly-sprite", "shell"],
      desktop: [
        "clock",
        "desktop-clipboard",
        "desktop-directory-picker",
        "desktop-notifications",
        "fly-sprite",
      ],
      mobile: ["mobile-clipboard", "mobile-notifications"],
    });
  });

  test("exposes only compiled runtime packages to the runtime host", async () => {
    const application = await createFoundationRuntimeApplication();

    expect(application.packages.map((pkg) => pkg.manifest)).toHaveLength(5);
    expect(application.packages.map((pkg) => pkg.specifier)).toEqual([
      "@frockbot/plugin-clock",
      "@frockbot/plugin-echo",
      "@frockbot/plugin-identity",
      "@frockbot/plugin-memory",
      "@frockbot/plugin-provider-foundation",
    ]);
  });
});
