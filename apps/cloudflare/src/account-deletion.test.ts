import { describe, expect, mock, test } from "bun:test";
import { workspaceObjectKeyV1 } from "@frockbot/core/workspace-store";
import type { WorkspaceRootV1 } from "@frockbot/core/contracts";
import type { AccountDeletionRecordV1 } from "@frockbot/app/account/deletion";
import {
  uploadObjectKeyV1,
  uploadTextKeyV1,
} from "@frockbot/app/uploads/shared";

// `mock.module` is process-global and the first registration in a suite run
// fixes the module's shape, so this stub has to satisfy every consumer the run
// loads — not only this file's. `@cloudflare/containers` imports both names.
mock.module("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    readonly ctx: DurableObjectState;
    readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class<Env> {
    readonly ctx: unknown;
    readonly env: Env;

    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { accountObjectPrefixesV1, runAccountDeletionStepV1 } =
  await import("./account-deletion.js");
type Seams = Parameters<typeof runAccountDeletionStepV1>[1];

const USER = "user:1/ü";

function record(
  overrides: Partial<AccountDeletionRecordV1> = {},
): AccountDeletionRecordV1 {
  return {
    schemaVersion: 1,
    userId: USER,
    commandId: "command-1",
    requestedAt: "2026-09-24T00:00:00.000Z",
    step: "access",
    attempts: 0,
    ...overrides,
  };
}

function seams(overrides: Partial<Seams> = {}): Seams {
  return {
    deleteGroupChats: async () => ({ status: "complete" }),
    deleteBots: async () => ({ status: "complete" }),
    recordedPaymentCustomer: () => undefined,
    vectorIdsAfter: () => [],
    deleteIdentity: async () => undefined,
    eraseVoice: async () => undefined,
    ...overrides,
  };
}

/** An object store holding exactly the keys it was given. */
function bucket(keys: string[]) {
  const held = new Set(keys);
  return {
    held,
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
      const matching = [...held].filter((key) => key.startsWith(prefix)).sort();
      return {
        objects: matching.slice(0, limit).map((key) => ({ key })),
        truncated: matching.length > limit,
      };
    },
    delete: async (keys: string[]) => {
      for (const key of keys) held.delete(key);
    },
  } as unknown as R2Bucket & { held: Set<string> };
}

describe("the account's files", () => {
  test("every root the User or a Bot of theirs owns is under one of the prefixes", () => {
    const roots: WorkspaceRootV1[] = [
      { kind: "user-instructions", userId: USER },
      { kind: "user-memory", userId: USER },
      { kind: "bot-instructions", userId: USER, botId: "bot-1" },
      { kind: "bot-memory", userId: USER, botId: "bot-1" },
      {
        kind: "package-declared",
        userId: USER,
        packageId: "@frockbot/app/notes",
        rootId: "notes",
      },
    ];
    const prefixes = accountObjectPrefixesV1(USER);
    for (const root of roots) {
      const key = workspaceObjectKeyV1(root, "skills/a/SKILL.md");
      expect(prefixes.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
    // And no other User's, however their id begins.
    for (const root of [
      { kind: "user-memory", userId: `${USER}x` },
      { kind: "bot-memory", userId: `${USER}:2`, botId: "bot-1" },
      {
        kind: "package-declared",
        userId: `${USER}x`,
        packageId: "p",
        rootId: "r",
      },
    ] as WorkspaceRootV1[]) {
      const key = workspaceObjectKeyV1(root, "a.md");
      expect(prefixes.some((prefix) => key.startsWith(prefix))).toBe(false);
    }
  });

  test("every Bot's uploads are under one of the prefixes, and no one else's", () => {
    const prefixes = accountObjectPrefixesV1(USER);
    const upload = "a".repeat(64);
    for (const key of [
      uploadObjectKeyV1(USER, "bot-1", upload),
      uploadTextKeyV1(USER, "bot-2", upload),
    ]) {
      expect(prefixes.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
    for (const key of [
      uploadObjectKeyV1(`${USER}x`, "bot-1", upload),
      uploadObjectKeyV1(`${USER}/bot-1`, "bot-1", upload),
    ]) {
      expect(prefixes.some((prefix) => key.startsWith(prefix))).toBe(false);
    }
  });

  test("deletes a page at a time and finishes on a pass that finds none", async () => {
    const mine = Array.from(
      { length: 1_001 },
      (_, index) =>
        `${accountObjectPrefixesV1(USER)[1]}notes/${String(index).padStart(4, "0")}.md`,
    );
    const theirs = workspaceObjectKeyV1(
      { kind: "user-memory", userId: "someone-else" },
      "a.md",
    );
    const store = bucket([...mine, theirs]);
    const env = { MEMORY_FILES: store };
    expect(
      await runAccountDeletionStepV1(env, seams(), "files", record()),
    ).toEqual({ status: "pending" });
    expect(
      await runAccountDeletionStepV1(env, seams(), "files", record()),
    ).toEqual({ status: "complete" });
    expect([...store.held]).toEqual([theirs]);
  });
});

describe("the account's connected apps", () => {
  function provider(listing: { triggers: string[]; accounts: string[] }) {
    const requests: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/trigger_instances/active"))
        return Response.json({
          items: listing.triggers.map((id) => ({ id })),
          next_cursor: null,
        });
      if (url.includes("/connected_accounts?"))
        return Response.json({
          items: listing.accounts.map((id) => ({ id })),
          next_cursor: null,
        });
      return new Response(null, { status: 204 });
    };
    return { requests, fetch };
  }

  test("lists by User, deletes triggers then accounts, and verifies once", async () => {
    const upstream = provider({ triggers: ["ti_1"], accounts: ["ca_1"] });
    const original = globalThis.fetch;
    globalThis.fetch = upstream.fetch as typeof fetch;
    try {
      const env = { COMPOSIO_API_KEY: "key" };
      const first = await runAccountDeletionStepV1(
        env,
        seams(),
        "connected-apps",
        record(),
      );
      expect(first).toEqual({ status: "pending", cursor: "verify" });
      expect(upstream.requests.filter((r) => r.startsWith("DELETE"))).toEqual([
        "DELETE https://backend.composio.dev/api/v3.1/trigger_instances/manage/ti_1",
        "DELETE https://backend.composio.dev/api/v3.1/connected_accounts/ca_1?revoke_on_delete=true",
      ]);
      // The provider may keep listing what it accepted the deletion of; the
      // verifying pass deletes it again and ends the step either way.
      expect(
        await runAccountDeletionStepV1(
          env,
          seams(),
          "connected-apps",
          record({ cursor: "verify" }),
        ),
      ).toEqual({ status: "complete" });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("nothing to reach without the provider key", async () => {
    expect(
      await runAccountDeletionStepV1({}, seams(), "connected-apps", record()),
    ).toEqual({ status: "complete" });
  });
});

describe("the account's payments", () => {
  test("a recorded customer with payments unconfigured is refused, not skipped", async () => {
    await expect(
      runAccountDeletionStepV1(
        {},
        seams({ recordedPaymentCustomer: () => "cus_1" }),
        "payments",
        record(),
      ),
    ).rejects.toThrow(/cus_1 cannot be deleted/);
    expect(
      await runAccountDeletionStepV1({}, seams(), "payments", record()),
    ).toEqual({ status: "complete" });
  });
});

describe("the account's Memory vectors", () => {
  test("deletes a page by id and resumes after the last one", async () => {
    const ids = ["a", "b", "c"];
    const deleted: string[][] = [];
    const env = {
      MEMORY_INDEX: {
        upsert: async () => undefined,
        query: async () => ({ matches: [] }),
        deleteByIds: async (page: string[]) => {
          deleted.push(page);
        },
      },
    };
    const vectors = seams({
      vectorIdsAfter: (cursor) =>
        ids.filter((id) => cursor === undefined || id > cursor),
    });
    expect(
      await runAccountDeletionStepV1(env, vectors, "memory-vectors", record()),
    ).toEqual({ status: "pending", cursor: "c" });
    expect(
      await runAccountDeletionStepV1(
        env,
        vectors,
        "memory-vectors",
        record({ cursor: "c" }),
      ),
    ).toEqual({ status: "complete" });
    expect(deleted).toEqual([["a", "b", "c"]]);
  });
});

describe("the account's access", () => {
  test("ends access first and forgets the record and invitation last", async () => {
    const calls: Array<[string, unknown]> = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        closeAccountForDeletion: async (input: unknown) => {
          calls.push(["close", input]);
        },
        forgetAccount: async (input: unknown) => {
          calls.push(["forget", input]);
        },
      }),
    } as unknown as DurableObjectNamespace;
    const env = { DEPLOYMENT_POLICY: namespace };
    await runAccountDeletionStepV1(env, seams(), "access", record());
    await runAccountDeletionStepV1(
      env,
      seams(),
      "admission",
      record({ email: "a@example.com" }),
    );
    expect(calls).toEqual([
      ["close", { schemaVersion: 1, userId: USER }],
      ["forget", { schemaVersion: 1, userId: USER, email: "a@example.com" }],
    ]);
  });
});
