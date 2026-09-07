import { describe, expect, test } from "bun:test";
import {
  AuditOutboxV1,
  auditEntriesFromStoredRunV1,
  type AuditProjectableRunV1,
} from "./bot.ts";
import { FakeAuditOutboxStorage } from "./testing.ts";
import { decodeAuditEntryV1, type AuditEntryV1 } from "./shared.ts";

const AT = "2026-08-31T02:00:00.000Z";

function call(
  occurrenceId: string,
  name: string,
  input: unknown,
): AuditProjectableRunV1["events"][number] {
  return { type: "tool/call", timestamp: AT, occurrenceId, name, input };
}

function result(
  occurrenceId: string,
  overrides: { content?: string; isError?: boolean; status?: string } = {},
): AuditProjectableRunV1["events"][number] {
  return {
    type: "tool/result",
    timestamp: AT,
    occurrenceId,
    name: "computer_exec",
    content: "",
    isError: false,
    status: "completed",
    ...overrides,
  };
}

function run(
  events: AuditProjectableRunV1["events"],
  status = "completed",
): AuditProjectableRunV1 {
  return { runId: "run-1", status, events, acceptedAt: AT };
}

describe("projecting a settled run", () => {
  test("audits the effects and ignores the rest", async () => {
    const entries = await auditEntriesFromStoredRunV1(
      "foreman",
      run([
        { type: "run/admitted", timestamp: AT },
        call("tool:1:1:0", "current_time", {}),
        result("tool:1:1:0", { content: "02:00" }),
        call("tool:1:2:0", "computer_exec", { command: "ls -la" }),
        result("tool:1:2:0", { content: "a\nb" }),
        call("tool:1:2:1", "mcp__example__echo", { message: "hi" }),
        result("tool:1:2:1", { content: "hi" }),
      ]),
    );
    expect(entries.map((entry) => entry.toolName)).toEqual([
      "computer_exec",
      "mcp__example__echo",
    ]);
    expect(entries[0]).toMatchObject({
      botId: "foreman",
      runId: "run-1",
      occurrenceId: "tool:1:2:0",
      // The occurrence id *is* the effect id: `plugin-shell` writes
      // `occurrenceId: context.effectId`, so the Computer envelope joins here.
      effectId: "tool:1:2:0",
      turn: 1,
      step: 2,
      ordinal: 0,
      kind: "shell",
      target: "computer",
      outcome: "ok",
      preview: "ls -la",
      bytesOut: 3,
    });
    expect(entries[1]).toMatchObject({
      kind: "mcp",
      target: "remote:example",
    });
    // Everything the table accepts, the decoder accepts.
    for (const entry of entries) {
      expect(decodeAuditEntryV1(JSON.parse(JSON.stringify(entry)))).toEqual(
        entry,
      );
    }
  });

  test("never carries the arguments, only their digest", async () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123";
    const [entry] = await auditEntriesFromStoredRunV1(
      "foreman",
      run([
        call("tool:1:1:0", "computer_exec", {
          command: `curl -H '${secret}' https://api.example`,
          env: { OPENAI_API_KEY: "sk-abcdefghijklmnopqrst" },
        }),
        result("tool:1:1:0"),
      ]),
    );
    const wire = JSON.stringify(entry);
    expect(wire).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(wire).not.toContain("OPENAI_API_KEY");
    expect(wire).not.toContain("env");
    expect(entry!.preview).toContain("[redacted:bearer-token]");
    expect(entry!.argumentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("names each outcome the durable events actually support", async () => {
    const outcomes = async (
      overrides: Parameters<typeof result>[1] | undefined,
    ) => {
      const events = [call("tool:1:1:0", "computer_exec", { command: "ls" })];
      if (overrides) events.push(result("tool:1:1:0", overrides));
      const [entry] = await auditEntriesFromStoredRunV1("foreman", run(events));
      return entry?.outcome;
    };
    expect(await outcomes({ content: "ok" })).toBe("ok");
    expect(await outcomes({ isError: true, content: "exit 1" })).toBe("error");
    expect(
      await outcomes({
        isError: true,
        content: "New calls are blocked while the user has taken control.",
      }),
    ).toBe("refused");
    expect(await outcomes({ status: "interrupted", content: "" })).toBe(
      "interrupted",
    );
    // No result at all is `unknown`, never `error`: the durable log does not
    // know how the effect ended, and inventing an answer is what the
    // reconciliation rule forbids.
    expect(await outcomes(undefined)).toBe("unknown");
  });

  test("projects nothing until the run has settled, and is deterministic", async () => {
    const events = [
      call("tool:1:1:0", "computer_exec", { command: "ls" }),
      result("tool:1:1:0"),
    ];
    expect(
      await auditEntriesFromStoredRunV1("foreman", run(events, "running")),
    ).toEqual([]);
    const first = await auditEntriesFromStoredRunV1("foreman", run(events));
    const second = await auditEntriesFromStoredRunV1("foreman", run(events));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("skips a call whose occurrence id it cannot place", async () => {
    expect(
      await auditEntriesFromStoredRunV1(
        "foreman",
        run([
          {
            type: "tool/call",
            timestamp: AT,
            occurrenceId: "legacy-1",
            name: "computer_exec",
            input: { command: "ls" },
          },
        ]),
      ),
    ).toEqual([]);
  });
});

function entries(count: number): AuditEntryV1[] {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    botId: "foreman",
    runId: "run-1",
    occurrenceId: `tool:1:1:${index}`,
    turn: 1,
    step: 1,
    ordinal: index,
    effectId: `tool:1:1:${index}`,
    at: AT,
    kind: "shell",
    target: "computer",
    toolName: "computer_exec",
    argumentDigest: "b".repeat(64),
    preview: `ls ${index}`,
    outcome: "ok",
  }));
}

describe("the Bot Durable Object's outbox", () => {
  test("holds entries durably until a sink accepts them", async () => {
    const outbox = new AuditOutboxV1(new FakeAuditOutboxStorage());
    await outbox.append(entries(3));
    expect(await outbox.state()).toEqual({ pending: 3, truncated: false });

    // A sink that throws clears nothing. That is the entire point of a queue.
    await expect(
      outbox.drain({
        indexEntries: () => Promise.reject(new Error("User object is away")),
      }),
    ).rejects.toThrow("User object is away");
    expect(await outbox.state()).toEqual({ pending: 3, truncated: false });

    const delivered: AuditEntryV1[] = [];
    const drain = await outbox.drain({
      indexEntries: async (batch) => {
        delivered.push(...batch);
      },
    });
    expect(drain.delivered).toBe(3);
    expect(delivered).toHaveLength(3);
    expect(await outbox.state()).toEqual({ pending: 0, truncated: false });
    // An empty outbox drains to a no-op rather than an empty delivery.
    expect(
      (await outbox.drain({ indexEntries: async () => {} })).delivered,
    ).toBe(0);
  });

  test("appends idempotently, so a re-projected run queues nothing twice", async () => {
    const outbox = new AuditOutboxV1(new FakeAuditOutboxStorage());
    await outbox.append(entries(2));
    await outbox.append(entries(2));
    expect(await outbox.state()).toEqual({ pending: 2, truncated: false });
  });

  test("drops the oldest past its bound and records that it did", async () => {
    const outbox = new AuditOutboxV1(new FakeAuditOutboxStorage(), {
      maximum: 4,
    });
    await outbox.append(entries(6));
    const state = await outbox.state();
    expect(state).toEqual({ pending: 4, truncated: true });

    const seen: string[] = [];
    await outbox.drain({
      indexEntries: async (batch) => {
        seen.push(...batch.map((entry) => entry.occurrenceId));
      },
    });
    // The newest four survived, and the loss outlives the drain: it describes
    // what was lost, not what is pending.
    expect(seen).toEqual([
      "tool:1:1:2",
      "tool:1:1:3",
      "tool:1:1:4",
      "tool:1:1:5",
    ]);
    expect(await outbox.state()).toEqual({ pending: 0, truncated: true });

    // Only a rebuild — which re-reads every run — may say the gap is closed.
    await outbox.clearTruncation();
    expect(await outbox.state()).toEqual({ pending: 0, truncated: false });
  });
});

describe("what the row is allowed to claim", () => {
  test("an approval-gated command is not `ok` before anybody approved it", async () => {
    const entries = await auditEntriesFromStoredRunV1(
      "foreman",
      run([
        call("tool:1:1:0", "machine_exec", {
          command: "rm -rf /tmp/build",
          machineId: "994dc2ee-1",
        }),
        result("tool:1:1:0", {
          content:
            'Command "cmd-1" is waiting on the user\'s approval. Nothing has run.',
        }),
      ]),
    );

    // The approval ends the Turn before anything runs, and `isError` is false
    // at queue time — so the row used to say `ok` for a command that had not
    // run and might never run.
    expect(entries[0]).toMatchObject({
      toolName: "machine_exec",
      target: "machine:994dc2ee-1",
      outcome: "unknown",
    });
  });

  test("a namespaced dynamic tool is recorded under the tool that ran", async () => {
    const entries = await auditEntriesFromStoredRunV1(
      "foreman",
      run([
        call("tool:1:1:0", "call_dynamic_tool", {
          namespace: "frockbot",
          toolName: "package_author",
          input: { packageId: "acme", path: "src/index.ts" },
        }),
        result("tool:1:1:0", { content: "written" }),
      ]),
    );

    // `package_author` produced no row at all before: it is a namespaced
    // dynamic tool, so the journalled name is `call_dynamic_tool`, and the
    // same hole hid every Composio and publisher call.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      toolName: "package_author",
      kind: "file",
      outcome: "ok",
    });
    expect(entries[0]?.preview).toContain("acme");
  });
});
