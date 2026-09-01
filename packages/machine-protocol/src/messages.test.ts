// Row 57g's DTOs: the seven calls, the permission report, and the one place
// the backend turns a machine's answer into a fact it will act on.
import { describe, expect, test } from "bun:test";
import {
  MACHINE_MESSAGES_CALL_KINDS_V1,
  MACHINE_MESSAGES_LIMITS_V1,
  MACHINE_OP_KINDS_V1,
  MachineDecodeError,
  decodeMachineMessagesCallV1,
  decodeMachineMessagesPermissionsV1,
  decodeMachineOpV1,
  machineMessagesCallIsReadV1,
  machineMessagesPermissionsFromResultV1,
  machineMessagesPermittedV1,
  machineOpCapabilityV1,
  type MachineMessagesCallV1,
  type MachineMessagesPermissionsV1,
} from "./protocol.js";

const permissions: MachineMessagesPermissionsV1 = {
  schemaVersion: 1,
  fullDiskAccess: true,
  automation: true,
  checkedAt: "2026-09-01T00:00:00.000Z",
};

describe("messages calls", () => {
  test("every call kind round-trips through its decoder", () => {
    const calls: MachineMessagesCallV1[] = [
      { kind: "check-permissions" },
      { kind: "find-chats", limit: 20 },
      { kind: "find-chats", query: "mum", limit: 5 },
      { kind: "chat-items", chatId: "iMessage;-;+61400000000", limit: 50 },
      { kind: "chat-items", chatId: "chat123", limit: 10, beforeRowId: 900 },
      { kind: "search", query: "dinner", limit: 25 },
      { kind: "activity", limit: 10 },
      { kind: "fetch-attachment", attachmentId: "42", maxBytes: 1024 },
      { kind: "send", to: "+61400000000", text: "on my way" },
    ];
    for (const call of calls) {
      expect(decodeMachineMessagesCallV1(call)).toEqual(call);
    }
    expect([...MACHINE_MESSAGES_CALL_KINDS_V1].sort()).toEqual(
      [...new Set(calls.map((call) => call.kind))].sort(),
    );
  });

  test("a field the schema does not declare is a refusal", () => {
    expect(() =>
      decodeMachineMessagesCallV1({ kind: "activity", limit: 5, all: true }),
    ).toThrow(MachineDecodeError);
    expect(() => decodeMachineMessagesCallV1({ kind: "listen" })).toThrow(
      MachineDecodeError,
    );
  });

  test("bounds are the protocol's, not the caller's", () => {
    expect(() =>
      decodeMachineMessagesCallV1({
        kind: "activity",
        limit: MACHINE_MESSAGES_LIMITS_V1.rows + 1,
      }),
    ).toThrow(/between 1 and/);
    expect(() =>
      decodeMachineMessagesCallV1({
        kind: "send",
        to: "+61400000000",
        text: "x".repeat(MACHINE_MESSAGES_LIMITS_V1.text + 1),
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      decodeMachineMessagesCallV1({
        kind: "fetch-attachment",
        attachmentId: "1",
        maxBytes: MACHINE_MESSAGES_LIMITS_V1.attachmentBytes + 1,
      }),
    ).toThrow(/between 1 and/);
  });

  test("only send is not a read", () => {
    expect(
      MACHINE_MESSAGES_CALL_KINDS_V1.filter(
        (kind) =>
          !machineMessagesCallIsReadV1({ kind } as MachineMessagesCallV1),
      ),
    ).toEqual(["send"]);
  });
});

describe("the messages op", () => {
  test("is an op like any other, and needs the messages capability", () => {
    const op = decodeMachineOpV1({
      kind: "messages",
      call: { kind: "activity", limit: 5 },
    });
    expect(op).toEqual({
      kind: "messages",
      call: { kind: "activity", limit: 5 },
    });
    expect(machineOpCapabilityV1(op)).toBe("messages");
    expect(MACHINE_OP_KINDS_V1).toContain("messages");
  });

  test("an undecodable call is an undecodable op", () => {
    expect(() =>
      decodeMachineOpV1({ kind: "messages", call: { kind: "send", to: "x" } }),
    ).toThrow(MachineDecodeError);
    expect(() =>
      decodeMachineOpV1({
        kind: "messages",
        call: { kind: "activity", limit: 1 },
        extra: 1,
      }),
    ).toThrow(MachineDecodeError);
  });
});

describe("permissions", () => {
  test("the report decodes exact-key", () => {
    expect(decodeMachineMessagesPermissionsV1(permissions)).toEqual(
      permissions,
    );
    expect(() =>
      decodeMachineMessagesPermissionsV1({ ...permissions, granted: true }),
    ).toThrow(MachineDecodeError);
    expect(() =>
      decodeMachineMessagesPermissionsV1({ ...permissions, checkedAt: "soon" }),
    ).toThrow(MachineDecodeError);
  });

  test("absent is a refusal, never a grant", () => {
    const read: MachineMessagesCallV1 = { kind: "activity", limit: 5 };
    const send: MachineMessagesCallV1 = { kind: "send", to: "x", text: "y" };
    expect(machineMessagesPermittedV1(read, undefined)).toBe(false);
    expect(machineMessagesPermittedV1(send, undefined)).toBe(false);
    // The check itself is how a machine stops being unknown, so it always runs.
    expect(
      machineMessagesPermittedV1({ kind: "check-permissions" }, undefined),
    ).toBe(true);
    expect(machineMessagesPermittedV1(read, permissions)).toBe(true);
    expect(
      machineMessagesPermittedV1(read, {
        ...permissions,
        fullDiskAccess: false,
      }),
    ).toBe(false);
    // Reading is Full Disk Access; sending additionally needs Automation.
    expect(
      machineMessagesPermittedV1(send, { ...permissions, automation: false }),
    ).toBe(false);
    expect(
      machineMessagesPermittedV1(read, { ...permissions, automation: false }),
    ).toBe(true);
  });

  test("a report is read off an ok permission check and nothing else", () => {
    const op = {
      kind: "messages",
      call: { kind: "check-permissions" },
    } as const;
    const stdout = JSON.stringify({ kind: "permissions", permissions });
    expect(
      machineMessagesPermissionsFromResultV1(op, { outcome: "ok", stdout }),
    ).toEqual(permissions);
    // Not a check, not ok, not JSON, not a report, not decodable: all undefined.
    expect(
      machineMessagesPermissionsFromResultV1(
        { kind: "messages", call: { kind: "activity", limit: 1 } },
        { outcome: "ok", stdout },
      ),
    ).toBeUndefined();
    expect(
      machineMessagesPermissionsFromResultV1(op, {
        outcome: "refused",
        stdout,
      }),
    ).toBeUndefined();
    expect(
      machineMessagesPermissionsFromResultV1(op, {
        outcome: "ok",
        stdout: "{",
      }),
    ).toBeUndefined();
    expect(
      machineMessagesPermissionsFromResultV1(op, {
        outcome: "ok",
        stdout: JSON.stringify({ kind: "chats", chats: [] }),
      }),
    ).toBeUndefined();
    expect(
      machineMessagesPermissionsFromResultV1(op, {
        outcome: "ok",
        stdout: JSON.stringify({
          kind: "permissions",
          permissions: { schemaVersion: 1, fullDiskAccess: true },
        }),
      }),
    ).toBeUndefined();
  });
});
