// Sends a device module's Apple Events (ADR 0037): the AppleScript on stdin is
// run, and what it returned is printed. The module host starts each run under a
// Seatbelt profile naming the one application it may reach; this program is
// what that profile starts, because `osascript` carries no Apple Events
// entitlement and a sandboxed sender without one is refused (-10004).

import Foundation

let limit = 64 * 1_024

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

var input = Data()
while input.count <= limit,
  let chunk = try? FileHandle.standardInput.read(upToCount: limit + 1 - input.count),
  !chunk.isEmpty
{
  input.append(chunk)
}
guard input.count <= limit else { fail("the script is longer than \(limit) bytes") }
guard let source = String(data: input, encoding: .utf8) else { fail("the script is not UTF-8") }
guard let script = NSAppleScript(source: source) else { fail("the script could not be read") }

var error: NSDictionary?
let result: NSAppleEventDescriptor? = script.executeAndReturnError(&error)
if let error = error {
  let message = error[NSAppleScript.errorMessage] as? String ?? "the script failed"
  let number = error[NSAppleScript.errorNumber] as? Int
  fail(number.map { "\(message) (\($0))" } ?? message)
}
print(result?.stringValue ?? "")
