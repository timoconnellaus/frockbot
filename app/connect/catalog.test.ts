import { describe, expect, test } from "bun:test";
import {
  CONNECT_APP_COUNT_V1,
  CONNECT_FEATURED_SLUGS_V1,
  CONNECT_TOOLKITS_V1,
  connectConnectionTypeIdV1,
  connectToolkitForConnectionTypeV1,
  connectToolkitV1,
} from "./catalog.js";

describe("the connected-app catalog", () => {
  test("gives every app one slug and one name", () => {
    const slugs = CONNECT_TOOLKITS_V1.map((toolkit) => toolkit.slug);
    const names = CONNECT_TOOLKITS_V1.map((toolkit) =>
      toolkit.name.toLowerCase(),
    );
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(names).size).toBe(names.length);
    expect(CONNECT_APP_COUNT_V1).toBe(CONNECT_TOOLKITS_V1.length);
  });

  test("leads with every featured app, in order, each one still generated", () => {
    expect(
      CONNECT_TOOLKITS_V1.slice(0, CONNECT_FEATURED_SLUGS_V1.length).map(
        (toolkit) => toolkit.slug,
      ),
    ).toEqual([...CONNECT_FEATURED_SLUGS_V1]);
  });

  test("uses slugs that are safe as namespaces and connection type ids", () => {
    for (const toolkit of CONNECT_TOOLKITS_V1) {
      expect(toolkit.slug).toMatch(/^[a-z][a-z0-9_]{0,48}$/);
      expect(
        connectToolkitForConnectionTypeV1(
          connectConnectionTypeIdV1(toolkit.slug),
        ),
      ).toBe(toolkit);
      expect(connectToolkitV1(toolkit.slug)).toBe(toolkit);
    }
    expect(connectToolkitForConnectionTypeV1("gmail")).toBeUndefined();
  });

  test("describes each app in one line without naming the provider", () => {
    for (const toolkit of CONNECT_TOOLKITS_V1) {
      expect(toolkit.description).toMatch(/^\S.{2,190}[.…]$/);
      expect(
        `${toolkit.slug} ${toolkit.name} ${toolkit.description}`.toLowerCase(),
      ).not.toContain("composio");
    }
  });

  test("offers an app whose sign-in asks for the person's own developer app", () => {
    expect(connectToolkitV1("xero")?.auth).toBe("OAUTH2");
    expect(connectToolkitV1("paypal")?.auth).toBe("S2S_OAUTH2");
  });

  test("offers no AI model provider as an app", () => {
    for (const slug of ["openai", "anthropic_administrator", "hugging_face"]) {
      expect(connectToolkitV1(slug)).toBeUndefined();
    }
  });
});
