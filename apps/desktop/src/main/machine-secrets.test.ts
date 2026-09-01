// The secret store, with a fake cipher standing in for the OS.
//
// The three states that matter are all here: a secret written and read back, a
// keychain that cannot encrypt (nothing is written, and nothing is written in
// the clear either), and a stored value that will not decrypt (dropped rather
// than surfaced).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import {
  DESKTOP_SECRET_FILE_V1,
  FileSecretStoreCapability,
  decodeDesktopSecretFileV1,
  type DesktopSecretCipherV1,
} from "./machine-secrets.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A cipher that is obviously not encryption, and obviously reversible. */
function rot(available = true, breaks = false): DesktopSecretCipherV1 {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) =>
      new Uint8Array(Buffer.from(`sealed:${value}`, "utf8")),
    decryptString: (value) => {
      if (breaks) throw new Error("the OS key has rotated");
      const text = Buffer.from(value).toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not ours");
      return text.slice("sealed:".length);
    },
  };
}

function store(cipher: DesktopSecretCipherV1): {
  store: FileSecretStoreCapability;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "machine-secrets-"));
  directories.push(directory);
  return {
    directory,
    store: new FileSecretStoreCapability(new Context(), { directory, cipher }),
  };
}

describe("desktop secret file", () => {
  test("anything unrecognisable decodes to an empty store", () => {
    expect(decodeDesktopSecretFileV1("nonsense")).toEqual({
      schemaVersion: 1,
      entries: {},
    });
    expect(
      decodeDesktopSecretFileV1({ schemaVersion: 2, entries: {} }),
    ).toEqual({ schemaVersion: 1, entries: {} });
    expect(
      decodeDesktopSecretFileV1({
        schemaVersion: 1,
        entries: { good: "abc", bad: 4 },
      }),
    ).toEqual({ schemaVersion: 1, entries: { good: "abc" } });
  });
});

describe("file secret store", () => {
  test("writes ciphertext, reads it back, and clears it", async () => {
    const mounted = store(rot());
    await mounted.store.write("frockbot.machine-token", "a-machine-token");

    const onDisk = readFileSync(
      join(mounted.directory, DESKTOP_SECRET_FILE_V1),
      "utf8",
    );
    // The token itself is never on disk in the clear.
    expect(onDisk).not.toContain("a-machine-token");
    expect(await mounted.store.read("frockbot.machine-token")).toBe(
      "a-machine-token",
    );

    await mounted.store.clear("frockbot.machine-token");
    expect(await mounted.store.read("frockbot.machine-token")).toBeUndefined();
  });

  test("a store with no OS encryption writes nothing rather than plaintext", async () => {
    const mounted = store(rot(false));
    await expect(
      mounted.store.write("frockbot.machine-token", "a-machine-token"),
    ).rejects.toThrow("no OS encryption is available");
    expect(await mounted.store.read("frockbot.machine-token")).toBeUndefined();
  });

  test("a value that will not decrypt reads as absent", async () => {
    const writable = store(rot());
    await writable.store.write("frockbot.machine-token", "a-machine-token");
    const rotated = new FileSecretStoreCapability(new Context(), {
      directory: writable.directory,
      cipher: rot(true, true),
    });
    expect(await rotated.read("frockbot.machine-token")).toBeUndefined();
  });

  test("reading before anything was ever written is not an error", async () => {
    const mounted = store(rot());
    expect(await mounted.store.read("frockbot.machine-token")).toBeUndefined();
    await mounted.store.clear("frockbot.machine-token");
  });

  test("one key's value does not disturb another's", async () => {
    const mounted = store(rot());
    await mounted.store.write("a", "one");
    await mounted.store.write("b", "two");
    await mounted.store.clear("a");
    expect(await mounted.store.read("b")).toBe("two");
  });
});
