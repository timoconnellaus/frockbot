import { describe, expect, test } from "bun:test";
import { base64urlEncodeV1 } from "@frockbot/core/crypto";
import {
  COMPUTER_LOGINS_RECORD_KEY,
  COMPUTER_LOGINS_SEALED_MAX_CHARACTERS,
  ComputerLoginsLedgerV1,
  createComputerLoginVaultV1,
  type ComputerLoginsUserRpcV1,
} from "./computer-logins.ts";

const KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "k1",
  keys: { k1: base64urlEncodeV1(new Uint8Array(32).fill(7)) },
});

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

/** The User's object, reduced to its ledger, behind the RPC the vault calls. */
function userObject(storage = new MemoryStorage()): {
  storage: MemoryStorage;
  ledger: ComputerLoginsLedgerV1;
  user: ComputerLoginsUserRpcV1;
} {
  const ledger = new ComputerLoginsLedgerV1(storage);
  return {
    storage,
    ledger,
    user: {
      readComputerLogins: ({ capture }) => ledger.answer(capture),
      keepComputerLogins: async ({ kept }) => ({
        outcome: await ledger.keep(kept),
      }),
      oweComputerLogins: async ({ at }) => ({ outcome: await ledger.owe(at) }),
      settleComputerLogins: ({ owedSince }) => ledger.settle(owedSince),
    },
  };
}

const encoder = new TextEncoder();
const cookies = encoder.encode(
  JSON.stringify({
    version: 1,
    cookies: [{ name: "sid", value: "secret-value", domain: ".a", path: "/" }],
  }),
);

describe("the User's sealed sign-ins", () => {
  test("round-trips a capture sealed, and the User's object never holds it in the clear", async () => {
    const { storage, user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;

    expect(
      await vault.keep({
        state: cookies,
        count: 1,
        capturedAt: "2026-09-24T00:00:00.000Z",
      }),
    ).toBe("kept");

    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      "secret-value",
    );
    const kept = await vault.kept();
    expect(kept?.count).toBe(1);
    expect(new TextDecoder().decode(kept!.state)).toBe(
      new TextDecoder().decode(cookies),
    );
  });

  test("a capture sealed for one User does not open as another's", async () => {
    const { storage, user } = userObject();
    await createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!.keep({
      state: cookies,
      count: 1,
      capturedAt: "2026-09-24T00:00:00.000Z",
    });

    const stranger = createComputerLoginVaultV1({
      userId: "user-2",
      keyring: KEYRING,
      user: userObject(storage).user,
    })!;

    await expect(stranger.kept()).rejects.toThrow(/authentication failed/);
  });

  test("keeps only a newer capture", async () => {
    const { user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;
    await vault.keep({
      state: cookies,
      count: 1,
      capturedAt: "2026-09-24T00:10:00.000Z",
    });

    expect(
      await vault.keep({
        state: encoder.encode("{}"),
        count: 0,
        capturedAt: "2026-09-24T00:05:00.000Z",
      }),
    ).toBe("stale");
    expect((await vault.kept())?.count).toBe(1);
  });

  test("keeps nothing while a machine is owed the kept sign-ins, and settles only the debt it read", async () => {
    const { user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;
    await vault.keep({
      state: cookies,
      count: 1,
      capturedAt: "2026-09-24T00:00:00.000Z",
    });
    await vault.owe("2026-09-24T01:00:00.000Z");
    await vault.owe("2026-09-24T02:00:00.000Z");

    expect(await vault.owed()).toBe("2026-09-24T01:00:00.000Z");
    // The new machine's browser has none of them; its capture is not kept.
    expect(
      await vault.keep({
        state: encoder.encode('{"version":1,"cookies":[]}'),
        count: 0,
        capturedAt: "2026-09-24T03:00:00.000Z",
      }),
    ).toBe("owed");
    await vault.settle("2026-09-24T02:00:00.000Z");
    expect(await vault.owed()).toBe("2026-09-24T01:00:00.000Z");
    await vault.settle("2026-09-24T01:00:00.000Z");
    expect(await vault.owed()).toBeUndefined();
    expect((await vault.kept())?.count).toBe(1);
  });

  test("a debt is read without the capture travelling with it", async () => {
    const { user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;
    await vault.keep({
      state: cookies,
      count: 1,
      capturedAt: "2026-09-24T00:00:00.000Z",
    });

    expect(
      await user.readComputerLogins({
        schemaVersion: 1,
        userId: "user-1",
        capture: false,
      }),
    ).toEqual({ version: 1 });
  });

  test("a capture too large to keep is refused, and the kept one stays", async () => {
    const { storage, user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;
    // Random bytes do not compress, so the sealed form outgrows the bound.
    const noise = new Uint8Array(COMPUTER_LOGINS_SEALED_MAX_CHARACTERS);
    for (let offset = 0; offset < noise.length; offset += 65_536) {
      crypto.getRandomValues(noise.subarray(offset, offset + 65_536));
    }

    expect(
      await vault.keep({
        state: noise,
        count: 9_999,
        capturedAt: "2026-09-24T00:00:00.000Z",
      }),
    ).toBe("too-large");
    expect(storage.values.has(COMPUTER_LOGINS_RECORD_KEY)).toBe(false);
  });

  test("Delete my Computer forgets the sign-ins and fences out everything from before it", async () => {
    const { storage, ledger, user } = userObject();
    const vault = createComputerLoginVaultV1({
      userId: "user-1",
      keyring: KEYRING,
      user,
    })!;
    await vault.keep({
      state: cookies,
      count: 1,
      capturedAt: "2026-09-24T00:00:00.000Z",
    });
    expect(await vault.owe("2026-09-24T01:00:00.000Z")).toBe("owed");

    await ledger.forget("2026-09-24T02:00:00.000Z");

    // Nothing kept and nothing owed: no machine can be handed them back.
    expect(await vault.kept()).toBeUndefined();
    expect(await vault.owed()).toBeUndefined();
    expect(storage.values.get(COMPUTER_LOGINS_RECORD_KEY)).toEqual({
      version: 1,
      deletedAt: "2026-09-24T02:00:00.000Z",
    });
    // An Update asked for before the deletion must not run; one after may.
    expect(await vault.deletedSince("2026-09-24T01:30:00.000Z")).toBe(true);
    expect(await vault.owe("2026-09-24T01:30:00.000Z")).toBe("deleted");
    expect(await vault.owed()).toBeUndefined();
    expect(await vault.deletedSince("2026-09-24T02:30:00.000Z")).toBe(false);
    // A capture of the machine that was deleted is not kept in its place.
    expect(
      await vault.keep({
        state: cookies,
        count: 1,
        capturedAt: "2026-09-24T01:59:00.000Z",
      }),
    ).toBe("stale");
    expect(await vault.kept()).toBeUndefined();
    // A later deletion never moves the fence back.
    await ledger.forget("2026-09-24T00:00:00.000Z");
    expect(await vault.deletedSince("2026-09-24T01:30:00.000Z")).toBe(true);
    // The Computer a Bot opens after it is the User's again.
    expect(
      await vault.keep({
        state: cookies,
        count: 1,
        capturedAt: "2026-09-24T03:00:00.000Z",
      }),
    ).toBe("kept");
    expect(await vault.owe("2026-09-24T04:00:00.000Z")).toBe("owed");
  });

  test("a deployment with no keyring keeps no sign-ins at all", () => {
    expect(
      createComputerLoginVaultV1({
        userId: "user-1",
        keyring: undefined,
        user: userObject().user,
      }),
    ).toBeUndefined();
  });
});
