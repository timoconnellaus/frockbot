// Where the machine token rests between launches.
//
// The constitution's "no secrets client-side" has exactly one exemption: a
// secret the operating system protects at rest. Electron's `safeStorage` is
// that — the login keychain on macOS, DPAPI on Windows, the secret service on
// Linux — and this file is everything about using it *except* the call to
// Electron, so the file format, the failure modes and the clearing all run in
// `bun test`.
//
// Two states matter and are handled rather than thrown:
//
//   * **encryption unavailable** — a headless Linux session with no keyring, a
//     locked keychain. Nothing is written. The agent then reads `undefined`,
//     stays unpaired, and says so. Writing the token in the clear instead
//     would be the one thing this file exists to prevent.
//   * **an unreadable store** — a file from another machine, a rotated OS key.
//     The entry is dropped rather than surfaced, because a token that will not
//     decrypt cannot be presented and keeping it only delays pairing again.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DesktopSecretStoreCapability } from "@frockbot/desktop-core";
import type { Context } from "cordis";

/** The OS's encryption, behind three calls. `safeStorage` satisfies it. */
export interface DesktopSecretCipherV1 {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
}

export const DESKTOP_SECRET_FILE_V1 = "frockbot-secrets.json";

/** The at-rest shape: key → base64 of the OS's ciphertext. Never plaintext. */
export interface DesktopSecretFileV1 {
  schemaVersion: 1;
  entries: Record<string, string>;
}

export function decodeDesktopSecretFileV1(input: unknown): DesktopSecretFileV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { schemaVersion: 1, entries: {} };
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.entries !== "object" ||
    value.entries === null ||
    Array.isArray(value.entries)
  ) {
    return { schemaVersion: 1, entries: {} };
  }
  const entries: Record<string, string> = {};
  for (const [key, held] of Object.entries(
    value.entries as Record<string, unknown>,
  )) {
    if (typeof held === "string" && held.length <= 32_768) entries[key] = held;
  }
  return { schemaVersion: 1, entries };
}

export interface FileSecretStoreOptionsV1 {
  /** The app's own data directory. One file is written inside it. */
  directory: string;
  cipher: DesktopSecretCipherV1;
}

export class FileSecretStoreCapability extends DesktopSecretStoreCapability {
  private readonly file: string;
  private readonly cipher: DesktopSecretCipherV1;

  constructor(ctx: Context, options: FileSecretStoreOptionsV1) {
    super(ctx);
    this.file = join(options.directory, DESKTOP_SECRET_FILE_V1);
    this.cipher = options.cipher;
  }

  private async load(): Promise<DesktopSecretFileV1> {
    try {
      return decodeDesktopSecretFileV1(
        JSON.parse(await readFile(this.file, "utf8")) as unknown,
      );
    } catch {
      return { schemaVersion: 1, entries: {} };
    }
  }

  private async save(held: DesktopSecretFileV1): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // Owner-only: the ciphertext is already the OS's, but a file mode is free.
    await writeFile(this.file, JSON.stringify(held), { mode: 0o600 });
  }

  async read(key: string): Promise<string | undefined> {
    if (!this.cipher.isEncryptionAvailable()) return undefined;
    const held = (await this.load()).entries[key];
    if (held === undefined) return undefined;
    try {
      return this.cipher.decryptString(Buffer.from(held, "base64"));
    } catch {
      return undefined;
    }
  }

  async write(key: string, value: string): Promise<void> {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error(
        "this computer cannot store a secret: no OS encryption is available",
      );
    }
    const held = await this.load();
    held.entries[key] = Buffer.from(this.cipher.encryptString(value)).toString(
      "base64",
    );
    await this.save(held);
  }

  async clear(key: string): Promise<void> {
    const held = await this.load();
    if (!(key in held.entries)) return;
    delete held.entries[key];
    await this.save(held);
  }
}
