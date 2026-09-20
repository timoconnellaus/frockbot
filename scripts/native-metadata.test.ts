import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readNativeMetadata } from "./native-metadata.ts";

const roots: string[] = [];

async function fixture(
  version = "1.6.0+7",
  hosted: unknown = {
    workers: { app: { hostnames: ["example.frockbot.test"] } },
  },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frockbot-native-metadata-"));
  roots.push(root);
  await mkdir(resolve(root, "apps/native"), { recursive: true });
  await mkdir(resolve(root, "deployments"), { recursive: true });
  await writeFile(
    resolve(root, "apps/native/pubspec.yaml"),
    `name: frockbot_native\nversion: ${version}\n`,
  );
  await writeFile(
    resolve(root, "deployments/hosted.json"),
    `${JSON.stringify(hosted)}\n`,
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("native metadata reports one checked build identity", async () => {
  const metadata = await readNativeMetadata(await fixture());
  expect(metadata).toEqual({
    schemaVersion: 1,
    app: {
      versionName: "1.6.0",
      buildNumber: 7,
      version: "1.6.0+7",
    },
    hostedOrigin: "https://example.frockbot.test",
    clientProtocol: 1,
    compatibility: {
      protocolMin: 1,
      protocolMax: 1,
      minimumNativeVersion: "1.6.0",
    },
  });
});

test("the generated client wire carries the built app version", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const metadata = await readNativeMetadata(repositoryRoot);
  const generated = await readFile(
    resolve(
      repositoryRoot,
      "apps/native/lib/protocol/client_wire.generated.dart",
    ),
    "utf8",
  );
  expect(generated).toContain(
    `const nativeAppVersion = '${metadata.app.versionName}';`,
  );
});

describe("malformed source metadata fails closed", () => {
  test("the pubspec version is a parsed YAML scalar with a release identity", async () => {
    await expect(
      readNativeMetadata(await fixture("development")),
    ).rejects.toThrow("version must be");
  });

  test("the hosted profile names a bare hostname", async () => {
    await expect(
      readNativeMetadata(
        await fixture("1.6.0+7", {
          workers: { app: { hostnames: ["example.test/path"] } },
        }),
      ),
    ).rejects.toThrow("hostname is invalid");
  });

  test("the generated compatibility range is coherent", async () => {
    await expect(
      readNativeMetadata(await fixture(), {
        clientProtocol: 2,
        protocolMin: 1,
        protocolMax: 1,
        minimumNativeVersion: "1.6.0",
      }),
    ).rejects.toThrow("outside the supported 1..1 range");
  });

  test("the app is not older than the server's minimum", async () => {
    await expect(
      readNativeMetadata(await fixture("1.5.9+7"), {
        clientProtocol: 1,
        protocolMin: 1,
        protocolMax: 1,
        minimumNativeVersion: "1.6.0",
      }),
    ).rejects.toThrow("below the minimum");
  });
});

test("the command emits only the structured JSON document", async () => {
  const root = await fixture();
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      resolve(import.meta.dirname, "native-metadata.ts"),
      "--root",
      root,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(
    await readNativeMetadata(root),
  );
});

test("the command rejects malformed source without partial JSON", async () => {
  const root = await fixture("not-a-version");
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      resolve(import.meta.dirname, "native-metadata.ts"),
      "--root",
      root,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("version must be");
});
