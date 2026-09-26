import { describe, expect, test } from "bun:test";
import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  decodeMachineClaimReceiptV1,
  decodeMachineCommandResultV1,
  decodeMachineCommandV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineEnrollmentV1,
  decodeMachineIdV1,
  decodeMachineListEntryV1,
  decodeMachineListViewV1,
  decodeMachineModuleCallClaimReceiptV1,
  decodeMachineModuleCallResultReceiptV1,
  decodeMachineModuleCallResultV1,
  decodeMachineModuleReportsReceiptV1,
  decodeMachineModuleReportsV1,
  decodeMachineModuleV1,
  decodeMachineOpV1,
  decodeMachinePairingOfferV1,
  decodeMachinePairingRequestV1,
  decodeMachinePathV1,
  decodeMachineRecordV1,
  decodeMachineResultReceiptV1,
  decodeMachineSocketFrameV1,
  machineListEntryV1,
  machineOpCapabilityV1,
  type MachineRecordV1,
} from "./protocol.ts";

const MACHINE_ID = "994dc2ee-3f42-4a4d-9f2a-0a3f6f0d1b77";
const DIGEST = "a".repeat(64);
const NOW = "2026-09-01T00:00:00.000Z";

const op = {
  kind: "exec",
  command: "git status",
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
} as const;

const command = {
  schemaVersion: 1,
  commandId: "tool:3:1:0",
  machineId: MACHINE_ID,
  botId: "foreman",
  runId: "run-1",
  turn: 3,
  approvalId: "tool:3:1:0",
  op,
  issuedAt: NOW,
  status: "queued",
} as const;

const module = {
  pluginId: "beeper",
  moduleId: "bridge",
  contentHash: "b".repeat(64),
  size: 1_024,
  read: [],
  net: ["localhost:23373"],
  appleEvents: [],
  calls: ["send"],
  events: ["message"],
};

const record: MachineRecordV1 = {
  schemaVersion: 1,
  machineId: MACHINE_ID,
  userId: "user-1",
  label: "Tims-M5-MacBook-Pro.local",
  platform: "macos",
  agentVersion: "0.1.0",
  capabilities: ["exec", "files"],
  registeredAt: "2026-08-30T00:00:00.000Z",
  lastSeenAt: NOW,
  keyVersion: 1,
  tokenDigest: DIGEST,
};

/**
 * Every DTO the protocol carries, with one accepted value each. The table is
 * what makes "exact-key at every seam" a property of the package rather than a
 * habit: a decoder added without its row is a decoder nobody proved refuses an
 * undeclared field.
 */
const DTOS: {
  name: string;
  decode: (input: unknown) => unknown;
  valid: Record<string, unknown>;
}[] = [
  {
    name: "pairing request",
    decode: decodeMachinePairingRequestV1,
    valid: { label: "Tims-M5-MacBook-Pro.local" },
  },
  {
    name: "pairing offer",
    decode: decodeMachinePairingOfferV1,
    valid: {
      schemaVersion: 1,
      code: "AB12-CD34-EF56",
      machineId: MACHINE_ID,
      expiresAt: NOW,
    },
  },
  {
    name: "enrollment",
    decode: decodeMachineEnrollmentV1,
    valid: {
      schemaVersion: 1,
      code: "AB12-CD34-EF56",
      label: "Tims-M5-MacBook-Pro.local",
      platform: "macos",
      agentVersion: "0.1.0",
      capabilities: ["exec", "files"],
    },
  },
  {
    name: "enrollment receipt",
    decode: decodeMachineEnrollmentReceiptV1,
    valid: {
      schemaVersion: 1,
      machineId: MACHINE_ID,
      token: "payload.signature",
      keyVersion: 1,
    },
  },
  { name: "op", decode: decodeMachineOpV1, valid: { ...op } },
  { name: "command", decode: decodeMachineCommandV1, valid: { ...command } },
  {
    name: "socket frame",
    decode: decodeMachineSocketFrameV1,
    valid: { type: "commands", commands: [{ ...command }], serverTime: NOW },
  },
  {
    name: "modules frame",
    decode: decodeMachineSocketFrameV1,
    valid: { type: "modules", modules: [{ ...module }], serverTime: NOW },
  },
  { name: "module", decode: decodeMachineModuleV1, valid: { ...module } },
  {
    name: "module reports",
    decode: decodeMachineModuleReportsV1,
    valid: {
      reports: [
        {
          pluginId: "beeper",
          moduleId: "bridge",
          kind: "state",
          state: "crashed",
          detail: "exit 1",
        },
        {
          pluginId: "beeper",
          moduleId: "bridge",
          kind: "log",
          level: "error",
          text: "connection refused",
        },
      ],
    },
  },
  {
    name: "module reports receipt",
    decode: decodeMachineModuleReportsReceiptV1,
    valid: { schemaVersion: 1, recorded: 2, dropped: 0 },
  },
  {
    name: "claim receipt",
    decode: decodeMachineClaimReceiptV1,
    valid: {
      schemaVersion: 1,
      status: "claimed",
      commandId: "tool:3:1:0",
      leaseExpiresAt: NOW,
    },
  },
  {
    name: "command result",
    decode: decodeMachineCommandResultV1,
    valid: {
      schemaVersion: 1,
      commandId: "tool:3:1:0",
      finishedAt: NOW,
      outcome: "ok",
      truncated: false,
      exitCode: 0,
      stdout: "clean",
    },
  },
  {
    name: "result receipt",
    decode: decodeMachineResultReceiptV1,
    valid: {
      schemaVersion: 1,
      status: "recorded",
      commandId: "tool:3:1:0",
    },
  },
  { name: "record", decode: decodeMachineRecordV1, valid: { ...record } },
  {
    name: "list entry",
    decode: decodeMachineListEntryV1,
    valid: machineListEntryV1(record, true) as unknown as Record<
      string,
      unknown
    >,
  },
  {
    name: "list view",
    decode: decodeMachineListViewV1,
    valid: {
      schemaVersion: 1,
      machines: [machineListEntryV1(record, true)],
      serverTime: NOW,
    },
  },
];

describe("machine protocol decoders", () => {
  for (const dto of DTOS) {
    test(`${dto.name} round-trips and refuses an undeclared field`, () => {
      expect(dto.decode(dto.valid)).toEqual(dto.valid);
      expect(() => dto.decode({ ...dto.valid, smuggled: true })).toThrow(
        /unknown field: smuggled/,
      );
      expect(() => dto.decode([dto.valid])).toThrow(/must be an object/);
      expect(() => dto.decode(null)).toThrow(/must be an object/);
    });
  }

  test("a decoder never returns a field the input did not carry", () => {
    const decoded = decodeMachineCommandV1({ ...command });
    expect(Object.hasOwn(decoded, "claimedAt")).toBe(false);
    expect(Object.hasOwn(decoded, "leaseExpiresAt")).toBe(false);
    expect(decodeMachinePairingRequestV1({})).toEqual({});
  });

  test("an unsupported schemaVersion is refused, not upgraded", () => {
    expect(() =>
      decodeMachineRecordV1({ ...record, schemaVersion: 2 }),
    ).toThrow(/schemaVersion is unsupported/);
  });
});

describe("machine identifiers and paths", () => {
  test("a machine id is opaque and audit-compatible", () => {
    expect(decodeMachineIdV1(MACHINE_ID)).toBe(MACHINE_ID);
    // The same rule `plugin-audit/src/classify.ts` applies to the tail of a
    // `machine:<id>` target, so every id minted here can be audited.
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(MACHINE_ID)).toBe(true);
    for (const bad of ["", "-leading", "has space", "tool:1:1:0", "a/b"]) {
      expect(() => decodeMachineIdV1(bad)).toThrow(MachineDecodeError);
    }
  });

  test("a command id may carry the effectId's colons", () => {
    expect(decodeMachineCommandV1({ ...command }).commandId).toBe("tool:3:1:0");
  });

  test("a machine path refuses control characters but allows a home path", () => {
    expect(decodeMachinePathV1("~/Documents/notes.md")).toBe(
      "~/Documents/notes.md",
    );
    expect(decodeMachinePathV1("C:\\Users\\tim\\notes.md")).toBe(
      "C:\\Users\\tim\\notes.md",
    );
    expect(() => decodeMachinePathV1("/tmp/a\u0000b")).toThrow(
      /control characters/,
    );
    expect(() => decodeMachinePathV1("")).toThrow(/non-empty/);
  });
});

describe("bounds", () => {
  test("every declared bound refuses one past it, with limit-exceeded", () => {
    const over = (input: unknown, decode: (value: unknown) => unknown) => {
      try {
        decode(input);
      } catch (error) {
        return error as MachineDecodeError;
      }
      throw new Error("expected a refusal");
    };
    expect(
      over(
        { ...op, command: "x".repeat(MACHINE_LIMITS_V1.command + 1) },
        decodeMachineOpV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        { ...op, maxOutputBytes: MACHINE_LIMITS_V1.outputBytes + 1 },
        decodeMachineOpV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        { ...op, timeoutMs: MACHINE_LIMITS_V1.execTimeoutMs + 1 },
        decodeMachineOpV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          kind: "read",
          path: "/tmp/a",
          maxBytes: MACHINE_LIMITS_V1.readBytes + 1,
        },
        decodeMachineOpV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          type: "commands",
          commands: Array.from(
            { length: MACHINE_LIMITS_V1.maxQueue + 1 },
            () => ({
              ...command,
            }),
          ),
          serverTime: NOW,
        },
        decodeMachineSocketFrameV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          type: "modules",
          modules: Array.from(
            { length: MACHINE_LIMITS_V1.modules + 1 },
            () => ({
              ...module,
            }),
          ),
          serverTime: NOW,
        },
        decodeMachineSocketFrameV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          reports: Array.from(
            { length: MACHINE_LIMITS_V1.moduleReports + 1 },
            () => ({
              pluginId: "beeper",
              moduleId: "bridge",
              kind: "log",
              level: "log",
              text: "x",
            }),
          ),
        },
        decodeMachineModuleReportsV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          reports: [
            {
              pluginId: "beeper",
              moduleId: "bridge",
              kind: "log",
              level: "log",
              text: "x".repeat(MACHINE_LIMITS_V1.moduleReportText + 1),
            },
          ],
        },
        decodeMachineModuleReportsV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          schemaVersion: 1,
          machines: Array.from(
            { length: MACHINE_LIMITS_V1.maxMachinesPerUser + 1 },
            () => machineListEntryV1(record, true),
          ),
          serverTime: NOW,
        },
        decodeMachineListViewV1,
      ).code,
    ).toBe("limit-exceeded");
  });

  test("the exec bounds accept exactly their ceiling", () => {
    expect(
      decodeMachineOpV1({
        ...op,
        timeoutMs: MACHINE_LIMITS_V1.execTimeoutMs,
        maxOutputBytes: MACHINE_LIMITS_V1.outputBytes,
      }),
    ).toMatchObject({ maxOutputBytes: MACHINE_LIMITS_V1.outputBytes });
  });

  test("a result's base64 payload must actually be base64", () => {
    const result = {
      schemaVersion: 1,
      commandId: "tool:3:1:0",
      finishedAt: NOW,
      outcome: "ok",
      truncated: true,
      bytesBase64: "aGVsbG8=",
    };
    expect(decodeMachineCommandResultV1(result)).toMatchObject({
      bytesBase64: "aGVsbG8=",
    });
    expect(() =>
      decodeMachineCommandResultV1({ ...result, bytesBase64: "not base64!" }),
    ).toThrow(/not valid base64/);
  });
});

describe("capabilities", () => {
  test("a repeated capability is refused rather than deduplicated", () => {
    expect(() =>
      decodeMachineRecordV1({ ...record, capabilities: ["exec", "exec"] }),
    ).toThrow(/repeats exec/);
  });

  test("an op names the capability it needs", () => {
    expect(machineOpCapabilityV1(op)).toBe("exec");
    expect(
      machineOpCapabilityV1({ kind: "read", path: "/tmp/a", maxBytes: 10 }),
    ).toBe("files");
    expect(
      machineOpCapabilityV1({
        kind: "copy-to-computer",
        path: "/tmp/a",
        workspacePath: "notes.md",
      }),
    ).toBe("files");
  });
});

describe("module reports", () => {
  test("a report's kind decides its fields, and an unknown kind is refused", () => {
    const base = { pluginId: "beeper", moduleId: "bridge" };
    expect(() =>
      decodeMachineModuleReportsV1({
        reports: [{ ...base, kind: "state", state: "running", text: "x" }],
      }),
    ).toThrow(/unknown field: text/);
    expect(() =>
      decodeMachineModuleReportsV1({
        reports: [{ ...base, kind: "event", level: "log", text: "x" }],
      }),
    ).toThrow(/kind must be state or log/);
    expect(() =>
      decodeMachineModuleReportsV1({
        reports: [{ ...base, kind: "state", state: "paused" }],
      }),
    ).toThrow(/state must be one of/);
    expect(() =>
      decodeMachineModuleReportsV1({
        reports: [
          { ...base, pluginId: "Beeper", kind: "log", level: "log", text: "x" },
        ],
      }),
    ).toThrow(/pluginId is invalid/);
  });
});

describe("the socket frame", () => {
  test("names its type, and refuses one it does not know", () => {
    expect(() =>
      decodeMachineSocketFrameV1({
        type: "hello",
        commands: [],
        serverTime: NOW,
      }),
    ).toThrow(/type is unsupported/);
  });
});

describe("presence is the caller's, never stored", () => {
  test("the list projection carries what it is told, unless revoked", () => {
    expect(machineListEntryV1(record, true).connected).toBe(true);
    expect(machineListEntryV1(record, false).connected).toBe(false);
    expect(
      machineListEntryV1({ ...record, revokedAt: NOW }, true).connected,
    ).toBe(false);
  });

  test("the list projection carries no proof of anything", () => {
    const entry = machineListEntryV1(record, true);
    expect(JSON.stringify(entry)).not.toContain(DIGEST);
    expect(JSON.stringify(entry)).not.toContain("user-1");
    expect(Object.hasOwn(entry, "keyVersion")).toBe(false);
  });
});

describe("a module call", () => {
  const frame = {
    type: "call" as const,
    callId: "mc-0123",
    pluginId: "beeper",
    moduleId: "bridge",
    call: "send",
    input: { chat: "c1", text: "hi" },
    deadline: "2026-09-01T00:00:10.000Z",
    serverTime: NOW,
  };

  test("arrives as a socket frame, decoded exactly", () => {
    expect(decodeMachineSocketFrameV1(frame)).toEqual(frame);
    expect(() => decodeMachineSocketFrameV1({ ...frame, extra: 1 })).toThrow(
      /unknown field: extra/,
    );
    expect(() =>
      decodeMachineSocketFrameV1({ ...frame, pluginId: "Beeper" }),
    ).toThrow(/pluginId is invalid/);
    expect(() =>
      decodeMachineSocketFrameV1({ ...frame, deadline: "soon" }),
    ).toThrow(/deadline must be a timestamp/);
    expect(() =>
      decodeMachineSocketFrameV1({
        ...frame,
        input: "x".repeat(MACHINE_LIMITS_V1.moduleCallJson),
      }),
    ).toThrow(MachineDecodeError);
  });

  test("is answered with a value or an error, and nothing else", () => {
    expect(decodeMachineModuleCallResultV1({ ok: true, value: [1] })).toEqual({
      ok: true,
      value: [1],
    });
    expect(decodeMachineModuleCallResultV1({ ok: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(decodeMachineModuleCallResultV1({ ok: false, error: "no" })).toEqual(
      { ok: false, error: "no" },
    );
    expect(() =>
      decodeMachineModuleCallResultV1({ ok: false, value: 1 }),
    ).toThrow(MachineDecodeError);
    expect(() => decodeMachineModuleCallResultV1({ ok: "yes" })).toThrow(
      MachineDecodeError,
    );
  });

  test("receipts name their status", () => {
    expect(
      decodeMachineModuleCallClaimReceiptV1({
        schemaVersion: 1,
        status: "refused",
        callId: "mc-1",
      }).status,
    ).toBe("refused");
    expect(
      decodeMachineModuleCallResultReceiptV1({
        schemaVersion: 1,
        status: "late",
        callId: "mc-1",
      }).status,
    ).toBe("late");
    expect(() =>
      decodeMachineModuleCallClaimReceiptV1({
        schemaVersion: 1,
        status: "already-claimed",
        callId: "mc-1",
      }),
    ).toThrow(MachineDecodeError);
  });
});
