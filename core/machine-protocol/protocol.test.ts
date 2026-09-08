import { describe, expect, test } from "bun:test";
import {
  MACHINE_LIMITS_V1,
  MACHINE_PRESENCE_TTL_MS,
  MachineDecodeError,
  decodeMachineClaimReceiptV1,
  decodeMachineCommandResultV1,
  decodeMachineCommandV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineEnrollmentV1,
  decodeMachineIdV1,
  decodeMachineListEntryV1,
  decodeMachineListViewV1,
  decodeMachineOpV1,
  decodeMachinePairingOfferV1,
  decodeMachinePairingRequestV1,
  decodeMachinePathV1,
  decodeMachinePollResultV1,
  decodeMachineRecordV1,
  decodeMachineResultReceiptV1,
  machineConnectedV1,
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
      capabilities: ["exec", "files", "messages"],
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
    name: "poll result",
    decode: decodeMachinePollResultV1,
    valid: { schemaVersion: 1, commands: [{ ...command }], serverTime: NOW },
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
    valid: machineListEntryV1(record, Date.parse(NOW)) as unknown as Record<
      string,
      unknown
    >,
  },
  {
    name: "list view",
    decode: decodeMachineListViewV1,
    valid: {
      schemaVersion: 1,
      machines: [machineListEntryV1(record, Date.parse(NOW))],
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
          schemaVersion: 1,
          commands: Array.from(
            { length: MACHINE_LIMITS_V1.maxQueue + 1 },
            () => ({
              ...command,
            }),
          ),
          serverTime: NOW,
        },
        decodeMachinePollResultV1,
      ).code,
    ).toBe("limit-exceeded");
    expect(
      over(
        {
          schemaVersion: 1,
          machines: Array.from(
            { length: MACHINE_LIMITS_V1.maxMachinesPerUser + 1 },
            () => machineListEntryV1(record, Date.parse(NOW)),
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
  test("only a macos agent may report messages", () => {
    const enrollment = {
      schemaVersion: 1,
      code: "AB12",
      label: "box",
      platform: "linux",
      agentVersion: "0.1.0",
      capabilities: ["exec", "messages"],
    };
    expect(() => decodeMachineEnrollmentV1(enrollment)).toThrow(
      /only report messages on macos/,
    );
    expect(
      decodeMachineEnrollmentV1({ ...enrollment, platform: "macos" })
        .capabilities,
    ).toEqual(["exec", "messages"]);
  });

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

describe("presence is arithmetic, not a stored flag", () => {
  const seen = Date.parse(NOW);

  test("reads connected up to the TTL and disconnected one millisecond past it", () => {
    expect(machineConnectedV1(record, seen)).toBe(true);
    expect(machineConnectedV1(record, seen + MACHINE_PRESENCE_TTL_MS)).toBe(
      true,
    );
    expect(machineConnectedV1(record, seen + MACHINE_PRESENCE_TTL_MS + 1)).toBe(
      false,
    );
    expect(machineConnectedV1(record, new Date(seen + 1_000))).toBe(true);
  });

  test("tolerates ordinary clock skew but not a wildly future last-seen", () => {
    expect(machineConnectedV1(record, seen - 1_000)).toBe(true);
    expect(machineConnectedV1(record, seen - MACHINE_PRESENCE_TTL_MS - 1)).toBe(
      false,
    );
  });

  test("a revoked machine is never connected, however fresh its poll", () => {
    expect(machineConnectedV1({ ...record, revokedAt: NOW }, seen)).toBe(false);
  });

  test("an unparseable last-seen reads disconnected rather than throwing", () => {
    expect(machineConnectedV1({ lastSeenAt: "never" }, seen)).toBe(false);
  });

  test("the list projection carries presence and no proof of anything", () => {
    const entry = machineListEntryV1(
      record,
      seen + MACHINE_PRESENCE_TTL_MS + 1,
    );
    expect(entry.connected).toBe(false);
    expect(JSON.stringify(entry)).not.toContain(DIGEST);
    expect(JSON.stringify(entry)).not.toContain("user-1");
    expect(Object.hasOwn(entry, "keyVersion")).toBe(false);
    // Pure: the same record and the same clock give the same row.
    expect(machineListEntryV1(record, seen)).toEqual(
      machineListEntryV1(record, seen),
    );
  });
});
