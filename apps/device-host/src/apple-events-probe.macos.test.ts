// Temporary: which Seatbelt profiles let osascript script Finder on CI.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const PROBE = 'tell application id "com.apple.finder" to count windows';
const run = (label: string, profile: string | undefined) => {
  const result = profile
    ? spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/usr/bin/osascript", "-e", PROBE],
        { encoding: "utf8", timeout: 20_000 },
      )
    : spawnSync("/usr/bin/osascript", ["-e", PROBE], {
        encoding: "utf8",
        timeout: 20_000,
      });
  console.log(
    `PROBE ${label}: ${result.status} ${result.stdout}${result.stderr}`,
  );
};

test.skipIf(process.platform !== "darwin")(
  "probe",
  () => {
    run("bare", undefined);
    run("allow-default", "(version 1)(allow default)");
    run(
      "allow-default-ae-finder",
      '(version 1)(allow default)(deny appleevent-send)(allow appleevent-send (appleevent-destination "com.apple.finder"))',
    );
    run(
      "allow-default-no-ae",
      "(version 1)(allow default)(deny appleevent-send)",
    );
    expect(true).toBe(true);
  },
  120_000,
);
