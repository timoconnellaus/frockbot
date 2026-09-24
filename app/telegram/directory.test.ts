import { describe, expect, test } from "bun:test";
import {
  claimTelegramLinkV1,
  decodeTelegramClaimV1,
  forgetTelegramUserV1,
  offerTelegramLinkV1,
  releaseTelegramAccountV1,
  resolveTelegramAccountV1,
  type TelegramDirectoryKvV1,
} from "./directory.js";

function memoryKv(): TelegramDirectoryKvV1 & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key, value) => void values.set(key, structuredClone(value)),
    delete: (key) => values.delete(key),
  };
}

const digest = (letter: string) => letter.repeat(64);
const NOW = Date.parse("2026-09-24T00:00:00.000Z");
const LATER = new Date(NOW + 600_000).toISOString();

describe("the Telegram directory", () => {
  test("a code links the account that sends it, once", () => {
    const kv = memoryKv();
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("a"),
      expiresAt: LATER,
    });
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("a"),
        telegramUserId: "42",
        now: NOW,
      }),
    ).toEqual({ status: "claimed", userId: "alice" });
    expect(resolveTelegramAccountV1(kv, "42")).toBe("alice");
    // Telegram redelivering the `/start` claims it again, the same way.
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("a"),
        telegramUserId: "42",
        now: NOW + 1,
      }),
    ).toEqual({ status: "claimed", userId: "alice" });
    // Anyone else who learns the code afterwards has nothing.
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("a"),
        telegramUserId: "43",
        now: NOW + 1,
      }),
    ).toEqual({ status: "invalid" });
    expect(resolveTelegramAccountV1(kv, "43")).toBeUndefined();
  });

  test("an expired or unknown code links nothing", () => {
    const kv = memoryKv();
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("a"),
      expiresAt: new Date(NOW).toISOString(),
    });
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("a"),
        telegramUserId: "42",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
    expect(kv.values.size).toBe(0);
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("b"),
        telegramUserId: "42",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
  });

  test("a new code retires the User's previous one", () => {
    const kv = memoryKv();
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("a"),
      expiresAt: LATER,
    });
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("b"),
      expiresAt: LATER,
    });
    expect(
      claimTelegramLinkV1(kv, {
        codeDigest: digest("a"),
        telegramUserId: "42",
        now: NOW,
      }).status,
    ).toBe("invalid");
    // One pending code per User, whatever they asked for.
    expect(kv.values.size).toBe(2);
  });

  test("an account another User claims names who it moved from", () => {
    const kv = memoryKv();
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("a"),
      expiresAt: LATER,
    });
    claimTelegramLinkV1(kv, {
      codeDigest: digest("a"),
      telegramUserId: "42",
      now: NOW,
    });
    offerTelegramLinkV1(kv, {
      userId: "bob",
      codeDigest: digest("b"),
      expiresAt: LATER,
    });
    const claim = claimTelegramLinkV1(kv, {
      codeDigest: digest("b"),
      telegramUserId: "42",
      now: NOW + 1,
    });
    expect(claim).toEqual({
      status: "claimed",
      userId: "bob",
      previousUserId: "alice",
    });
    expect(decodeTelegramClaimV1(structuredClone(claim))).toEqual(claim);
    expect(resolveTelegramAccountV1(kv, "42")).toBe("bob");
    // Alice's late unlink cannot take the account from Bob.
    expect(
      releaseTelegramAccountV1(kv, { userId: "alice", telegramUserId: "42" }),
    ).toBe(false);
    expect(
      releaseTelegramAccountV1(kv, { userId: "bob", telegramUserId: "42" }),
    ).toBe(true);
    expect(resolveTelegramAccountV1(kv, "42")).toBeUndefined();
  });

  test("a User links one account at a time", () => {
    const kv = memoryKv();
    for (const [letter, account] of [
      ["a", "42"],
      ["b", "43"],
    ] as const) {
      offerTelegramLinkV1(kv, {
        userId: "alice",
        codeDigest: digest(letter),
        expiresAt: LATER,
      });
      claimTelegramLinkV1(kv, {
        codeDigest: digest(letter),
        telegramUserId: account,
        now: NOW,
      });
    }
    expect(resolveTelegramAccountV1(kv, "42")).toBeUndefined();
    expect(resolveTelegramAccountV1(kv, "43")).toBe("alice");
  });

  test("a deleted account leaves nothing behind", () => {
    const kv = memoryKv();
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("a"),
      expiresAt: LATER,
    });
    claimTelegramLinkV1(kv, {
      codeDigest: digest("a"),
      telegramUserId: "42",
      now: NOW,
    });
    offerTelegramLinkV1(kv, {
      userId: "alice",
      codeDigest: digest("b"),
      expiresAt: LATER,
    });
    forgetTelegramUserV1(kv, "alice");
    expect(kv.values.size).toBe(0);
    // Repeating it, as a retried deletion step does, changes nothing.
    forgetTelegramUserV1(kv, "alice");
    expect(kv.values.size).toBe(0);
  });
});
