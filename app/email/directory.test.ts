import { describe, expect, test } from "bun:test";
import {
  forgetInboundEmailUserV1,
  registerInboundAddressV1,
  releaseInboundAddressV1,
  resolveInboundAddressV1,
  type InboundEmailDirectoryKvV1,
} from "./directory.ts";

function memoryKv(): InboundEmailDirectoryKvV1 & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => void map.set(key, structuredClone(value)),
    delete: (key) => map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b)) as [string, T][],
    keys: () => [...map.keys()].sort(),
  };
}

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("the inbound email directory", () => {
  test("a token's digest names its User and Bot until the Bot's address rotates", () => {
    const kv = memoryKv();
    registerInboundAddressV1(kv, {
      userId: "user-1",
      botId: "fox",
      tokenDigest: A,
    });
    expect(resolveInboundAddressV1(kv, A)).toEqual({
      userId: "user-1",
      botId: "fox",
    });
    registerInboundAddressV1(kv, {
      userId: "user-1",
      botId: "fox",
      tokenDigest: B,
    });
    expect(resolveInboundAddressV1(kv, A)).toBeUndefined();
    expect(resolveInboundAddressV1(kv, B)).toEqual({
      userId: "user-1",
      botId: "fox",
    });
  });

  test("releasing a Bot's address forgets it, and only its own", () => {
    const kv = memoryKv();
    registerInboundAddressV1(kv, { userId: "u", botId: "fox", tokenDigest: A });
    registerInboundAddressV1(kv, { userId: "u", botId: "owl", tokenDigest: B });
    expect(releaseInboundAddressV1(kv, { userId: "u", botId: "fox" })).toBe(
      true,
    );
    expect(resolveInboundAddressV1(kv, A)).toBeUndefined();
    expect(resolveInboundAddressV1(kv, B)).toEqual({
      userId: "u",
      botId: "owl",
    });
    expect(releaseInboundAddressV1(kv, { userId: "u", botId: "fox" })).toBe(
      false,
    );
  });

  test("a deleted account's addresses go, and no one else's", () => {
    const kv = memoryKv();
    registerInboundAddressV1(kv, {
      userId: "google:1",
      botId: "fox",
      tokenDigest: A,
    });
    registerInboundAddressV1(kv, {
      userId: "google:1",
      botId: "owl",
      tokenDigest: B,
    });
    // A User id that the first one is a prefix of.
    registerInboundAddressV1(kv, {
      userId: "google:10",
      botId: "fox",
      tokenDigest: C,
    });
    forgetInboundEmailUserV1(kv, "google:1");
    expect(resolveInboundAddressV1(kv, A)).toBeUndefined();
    expect(resolveInboundAddressV1(kv, B)).toBeUndefined();
    expect(resolveInboundAddressV1(kv, C)).toEqual({
      userId: "google:10",
      botId: "fox",
    });
    expect(kv.keys().filter((key) => key.includes("google:1/"))).toEqual([]);
  });
});
