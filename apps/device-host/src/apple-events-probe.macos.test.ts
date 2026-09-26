// Temporary: does an ad-hoc-signed helper carrying an Apple Events sandbox
// exception reach Finder under Seatbelt, where a bare osascript cannot?
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = `import Foundation
let script = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
var error: NSDictionary?
let result = NSAppleScript(source: script)?.executeAndReturnError(&error)
if let error { FileHandle.standardError.write("\\(error)".data(using: .utf8)!); exit(1) }
print(result?.stringValue ?? "")
`;

const ENTITLEMENTS = (
  targets: string[],
) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.temporary-exception.apple-events</key>
<array>${targets.map((t) => `<string>${t}</string>`).join("")}</array>
</dict></plist>`;

const FINDER = 'tell application id "com.apple.finder" to count windows';
const SYSTEM_EVENTS =
  'tell application id "com.apple.systemevents" to count processes';

test.skipIf(process.platform !== "darwin")(
  "probe",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-probe-"));
    await writeFile(join(dir, "helper.swift"), SOURCE);
    await writeFile(
      join(dir, "finder.plist"),
      ENTITLEMENTS(["com.apple.finder"]),
    );
    const sh = (
      label: string,
      command: string,
      args: string[],
      input?: string,
    ) => {
      const r = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 60_000,
        input,
      });
      console.log(
        `PROBE ${label}: ${r.status} ${r.stdout}${r.stderr}`.slice(0, 600),
      );
      return r.status;
    };
    sh("swiftc", "/usr/bin/xcrun", [
      "swiftc",
      "-O",
      "-o",
      join(dir, "plain"),
      join(dir, "helper.swift"),
    ]);
    sh("cp", "/bin/cp", [join(dir, "plain"), join(dir, "signed")]);
    sh("sign-plain", "/usr/bin/codesign", [
      "-s",
      "-",
      "-f",
      join(dir, "plain"),
    ]);
    sh("sign-finder", "/usr/bin/codesign", [
      "-s",
      "-",
      "-f",
      "--entitlements",
      join(dir, "finder.plist"),
      join(dir, "signed"),
    ]);
    const strict = (exe: string) => `(version 1)
(deny default)
(import "bsd.sb")
(allow process-exec (literal "${exe}"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/Library/ScriptingAdditions") (subpath "/private/var/db/dyld") (subpath "${dir}"))
(allow file-read-metadata)
(allow mach-lookup (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.CoreServices.coreservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.tccd") (global-name "com.apple.tccd.system"))
(allow appleevent-send (appleevent-destination "com.apple.finder"))
`;
    for (const exe of ["plain", "signed"]) {
      const path = join(dir, exe);
      sh(`${exe} bare finder`, path, [], FINDER);
      sh(
        `${exe} allow-default finder`,
        "/usr/bin/sandbox-exec",
        ["-p", "(version 1)(allow default)", path],
        FINDER,
      );
      sh(
        `${exe} strict finder`,
        "/usr/bin/sandbox-exec",
        ["-p", strict(path), path],
        FINDER,
      );
      sh(
        `${exe} strict system-events`,
        "/usr/bin/sandbox-exec",
        ["-p", strict(path), path],
        SYSTEM_EVENTS,
      );
      sh(
        `${exe} strict shell`,
        "/usr/bin/sandbox-exec",
        ["-p", strict(path), path],
        'do shell script "echo hi"',
      );
    }
    expect(true).toBe(true);
  },
  300_000,
);
