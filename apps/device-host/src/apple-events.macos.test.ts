// The Apple Events profile, proved on macOS: `osascript` must start and run a
// script under it, and be refused a shell and any application but the one the
// profile names.
//
// The declared application itself cannot be proved here: an Apple Event to it
// needs the person's Automation consent, which only a person can give, so on CI
// it would wait on a prompt nobody answers. The Finder case instead names some
// other application in the profile, so it is the profile that refuses it.

import { describe, expect, test } from "bun:test";

import { runAppleEventsV1 } from "./apple-events.ts";

const OTHER = "com.example.not-finder";

describe.skipIf(process.platform !== "darwin")(
  "the Apple Events profile, run",
  () => {
    test("runs a script that reaches nothing", async () => {
      expect(await runAppleEventsV1(OTHER, "return 1 + 1")).toBe("2");
    }, 30_000);

    // A timeout would also reject, so each refusal must be osascript's own.
    const refusal = (script: string) =>
      runAppleEventsV1(OTHER, script, { timeoutMs: 20_000 }).then(
        (value) => `ran: ${value}`,
        (error: Error) => error.message,
      );

    test("refuses a shell", async () => {
      const outcome = await refusal('do shell script "echo hi"');
      expect(outcome).not.toStartWith("ran:");
      expect(outcome).not.toContain("did not finish");
    }, 30_000);

    test("refuses an application the profile does not name", async () => {
      const outcome = await refusal(
        'tell application id "com.apple.finder" to get name',
      );
      expect(outcome).not.toStartWith("ran:");
      expect(outcome).not.toContain("did not finish");
    }, 30_000);
  },
);
