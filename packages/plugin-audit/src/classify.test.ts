import { describe, expect, test } from "bun:test";
import { auditKindForToolV1 } from "./classify.ts";
import {
  decodeAuditOccurrenceIdV1,
  isAuditTargetV1,
  type AuditKindV1,
} from "./shared.ts";

describe("the classifier table", () => {
  const table: Array<[string, unknown, AuditKindV1 | undefined, string?]> = [
    ["computer_exec", { command: "ls" }, "shell", "computer"],
    [
      "computer_exec",
      { command: "npm run dev", background: true },
      "process",
      "computer",
    ],
    ["computer_screenshot", {}, undefined],
    ["computer_process_check", { processId: "p1" }, "process", "computer"],
    ["computer_process_logs", { processId: "p1" }, "process", "computer"],
    ["computer_process_stop", { processId: "p1" }, "process", "computer"],
    ["computer_browser", { action: "navigate" }, "browser", "computer"],
    [
      "computer_process_start",
      { command: "npm run dev" },
      "process",
      "computer",
    ],
    ["computer_process_poll", { processId: "p1" }, "process", "computer"],
    // Memory and Skills are the Workspace, not the Computer: they are
    // written while it is hibernated and by Bots that have none.
    ["memory_write", { text: "a fact" }, "file", "workspace"],
    ["skill_write", { path: "a.md" }, "file", "workspace"],
    ["package_author", { packageId: "x" }, "file", "workspace"],
    ["mcp__example__echo", { message: "hi" }, "mcp", "remote:example"],
    ["mcp__beeper__send_message", {}, "mcp", "remote:beeper"],
    // Read-only and product tools perform no audited effect at all. An audit
    // surface that logged them would be a transcript.
    ["current_time", {}, undefined],
    ["memory_search", { query: "gym" }, undefined],
    ["skill_load", { skill: "a" }, undefined],
    ["send_to_user", { text: "hi" }, undefined],
    ["mcp__", {}, undefined],
  ];

  for (const [name, input, kind, target] of table) {
    test(`${name} → ${kind ?? "not audited"}`, () => {
      const classification = auditKindForToolV1(name, input);
      if (kind === undefined) {
        expect(classification).toBeUndefined();
        return;
      }
      expect(classification?.kind).toBe(kind);
      expect(classification?.target).toBe(target!);
      expect(isAuditTargetV1(classification!.target)).toBe(true);
    });
  }

  test("the registered machine's tools audit against the machine they named", () => {
    // Register rows 48 and 49. Every `machine_*` tool carries `machineId` on
    // its input verbatim, which is what lets the table answer `machine:<id>`
    // without knowing anything about the Package that produced the call.
    expect(
      auditKindForToolV1("machine_exec", {
        machineId: "994dc2ee-1",
        command: "git status",
      }),
    ).toEqual({ kind: "shell", target: "machine:994dc2ee-1" });
    for (const name of [
      "machine_read",
      "machine_copy_to_computer",
      "machine_copy_from_computer",
    ]) {
      expect(
        auditKindForToolV1(name, { machineId: "994dc2ee-1", path: "/tmp/x" }),
      ).toEqual({ kind: "file", target: "machine:994dc2ee-1" });
    }
    // Reading the registry and reading a command's own result perform no
    // external effect, so they are not audited at all: an audit surface that
    // logged every tool call would be a transcript.
    for (const name of ["machine_list", "machine_command_check"]) {
      expect(auditKindForToolV1(name, { commandId: "c1" })).toBeUndefined();
    }
    // Row 57g. Every one of the seven Messages verbs is an `mcp` row against
    // the Mac it named — reaching a service on somebody's laptop, which is the
    // shape §4.2 gives them — and the send is audited exactly like the reads.
    for (const name of [
      "machine_messages_check_permissions",
      "machine_messages_find_chats",
      "machine_messages_chat_items",
      "machine_messages_search",
      "machine_messages_activity",
      "machine_messages_fetch_attachment",
      "machine_messages_send",
    ]) {
      expect(auditKindForToolV1(name, { machineId: "994dc2ee-1" })).toEqual({
        kind: "mcp",
        target: "machine:994dc2ee-1",
      });
    }
    // A machine tool that named no machine could not have run; the row says
    // so by falling back to the target it did name.
    expect(auditKindForToolV1("machine_exec", { command: "ls" })).toEqual({
      kind: "shell",
      target: "computer",
    });
  });

  test("a Computer tool is audited against the Computer, whatever it claims", () => {
    // `machineId` is model-supplied. Deriving the target from it on every tool
    // let a Bot run a command on the Computer and have the durable audit row
    // say it ran on the User's laptop — the one field the row exists to be
    // trusted on.
    expect(
      auditKindForToolV1("computer_exec", {
        command: "ls",
        machineId: "994dc2ee-1",
      }),
    ).toEqual({ kind: "shell", target: "computer" });
    // The machine's own verbs still name the machine they reached.
    expect(
      auditKindForToolV1("machine_exec", {
        command: "ls",
        machineId: "994dc2ee-1",
      }),
    ).toEqual({ kind: "shell", target: "machine:994dc2ee-1" });
    // A malformed machine id is the Bot's own Computer, not a target the row
    // would be lying about.
    expect(
      auditKindForToolV1("machine_exec", { command: "ls", machineId: "../x" }),
    ).toEqual({ kind: "shell", target: "computer" });
  });

  test("a namespaced dynamic tool is classified on the tool it resolves to", () => {
    // `package_author` was dead: it is a namespaced dynamic tool, so the
    // journalled name is `call_dynamic_tool` and no row was ever produced —
    // the same hole hid every Composio and publisher call.
    expect(
      auditKindForToolV1("call_dynamic_tool", {
        namespace: "frockbot",
        toolName: "package_author",
        input: { packageId: "acme" },
      }),
      // `package_author` writes the Workspace, not the Computer.
    ).toEqual({ kind: "file", target: "workspace" });
    // A wrapper that names nothing resolvable stays the wrapper, and the
    // wrapper is not an audited effect.
    expect(auditKindForToolV1("call_dynamic_tool", {})).toBeUndefined();
  });

  test("an MCP tool whose own name contains __ still names its server", () => {
    // The slug capture was greedy: `mcp__gh__list__files` reported server
    // `gh__list`, a target no Connection can resolve to a host.
    expect(auditKindForToolV1("mcp__gh__list__files", {})).toEqual({
      kind: "mcp",
      target: "remote:gh",
    });
  });

  test("is pure: the same call always classifies the same way", () => {
    const first = auditKindForToolV1("computer_exec", { command: "ls" });
    const second = auditKindForToolV1("computer_exec", { command: "ls" });
    expect(first).toEqual(second!);
  });

  test("is total: no input throws", () => {
    for (const input of [undefined, null, 1, "text", [], { machineId: 7 }]) {
      expect(() => auditKindForToolV1("computer_exec", input)).not.toThrow();
    }
  });
});

describe("occurrence-id decoding", () => {
  test("names the turn, step and ordinal already in the durable event", () => {
    expect(decodeAuditOccurrenceIdV1("tool:3:2:0")).toEqual({
      turn: 3,
      step: 2,
      ordinal: 0,
    });
    expect(decodeAuditOccurrenceIdV1("tool:1:1:11")).toEqual({
      turn: 1,
      step: 1,
      ordinal: 11,
    });
  });

  test("refuses anything the kernel would not have written", () => {
    for (const value of [
      "tool:0:1:0",
      "tool:1:0:0",
      "tool:1:1",
      "tool:1:1:0:0",
      "call:1:1:0",
      "tool:-1:1:0",
      "",
      42,
    ]) {
      expect(() => decodeAuditOccurrenceIdV1(value)).toThrow();
    }
  });
});

describe("target shapes", () => {
  test("accepts exactly the three the schema declares", () => {
    expect(isAuditTargetV1("computer")).toBe(true);
    expect(isAuditTargetV1("machine:Tims-M5")).toBe(true);
    expect(isAuditTargetV1("remote:mcp.example.test")).toBe(true);
    expect(isAuditTargetV1("remote:mcp.example.test:8443")).toBe(true);
    expect(isAuditTargetV1("box")).toBe(false);
    expect(isAuditTargetV1("machine:")).toBe(false);
    expect(isAuditTargetV1("remote:/etc/passwd")).toBe(false);
  });
});
