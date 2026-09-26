// The Apple Events profile, proved on macOS: `osascript` must start and run a
// script under it, and be refused a shell and any application but the one the
// profile names.
//
// The declared application itself cannot be proved here: an Apple Event to it
// needs the person's Automation consent, which only a person can give, so on CI
// it would wait on a prompt nobody answers. The Finder case instead names some
// other application in the profile, so it is the profile that refuses it; and
// where the runner already grants scripting Finder, naming Finder must run.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

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

    // `get name` of an application is answered by AppleScript itself, without
    // an Apple Event, so the probe must ask the application for something.
    const FINDER = "com.apple.finder";
    const PROBE = `tell application id "${FINDER}" to count windows`;

    test("refuses an application the profile does not name", async () => {
      const outcome = await refusal(PROBE);
      console.log(`unnamed Finder: ${outcome}`);
      expect(outcome).not.toStartWith("ran:");
      expect(outcome).not.toContain("did not finish");

      // Where this machine already lets osascript script Finder, as CI
      // runners do, the same script under a profile that names Finder must
      // run: then the refusal above is the profile's, not a missing consent.
      const bare = spawnSync("/usr/bin/osascript", ["-e", PROBE], {
        encoding: "utf8",
        timeout: 20_000,
      });
      console.log(
        `unsandboxed Finder: status ${bare.status} ${bare.stdout}${bare.stderr}`,
      );
      if (bare.status !== 0) return;
      const named = await runAppleEventsV1(FINDER, PROBE, {
        timeoutMs: 20_000,
      }).then(
        (value) => `ran: ${value}`,
        (error: Error) => error.message,
      );
      console.log(`named Finder: ${named}`);
      if (!named.startsWith("ran:")) {
        // What the profile refused, so a failure names the missing rule.
        const denials = spawnSync(
          "/usr/bin/log",
          [
            "show",
            "--last",
            "1m",
            "--style",
            "compact",
            "--predicate",
            'sender == "Sandbox" AND eventMessage CONTAINS "osascript"',
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        console.log(`sandbox denials:\n${denials.stdout}${denials.stderr}`);
      }
      expect(named).toStartWith("ran:");
    }, 60_000);
  },
);
