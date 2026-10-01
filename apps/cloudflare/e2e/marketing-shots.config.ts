// The marketing screenshots run on the browser harness but are not a test:
// they are kept out of the e2e corpus by their suffix and run only from here.
process.env.FROCKBOT_E2E_SUITE ??= "core";
const { default: base } = await import("./playwright.config.ts");

export default {
  ...base,
  testMatch: "marketing.shots.ts",
  testIgnore: [],
  workers: 1,
};
