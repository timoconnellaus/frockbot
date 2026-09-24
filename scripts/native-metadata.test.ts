import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLIENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_MAX,
  SUPPORTED_PROTOCOL_MIN,
} from "../core/protocol-schemas/compatibility.generated.js";
import { readNativeMetadata } from "./native-metadata.ts";

const roots: string[] = [];

async function fixture(
  version = "0.0.0+1",
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

test("a build outside a release is named by the pubspec placeholder", async () => {
  const metadata = await readNativeMetadata(await fixture(), undefined, "");
  expect(metadata).toEqual({
    schemaVersion: 1,
    release: null,
    app: {
      versionName: "0.0.0",
      buildNumber: 1,
      version: "0.0.0+1",
    },
    hostedOrigin: "https://example.frockbot.test",
    clientProtocol: CLIENT_PROTOCOL_VERSION,
    compatibility: {
      protocolMin: SUPPORTED_PROTOCOL_MIN,
      protocolMax: SUPPORTED_PROTOCOL_MAX,
    },
  });
});

test("a release build is named by its tag", async () => {
  const root = await fixture();
  const release = await readNativeMetadata(root, undefined, "0.7.163");
  expect(release.release).toBe("0.7.163");
  expect(release.app).toEqual({
    versionName: "0.7.163",
    buildNumber: 1,
    version: "0.7.163+1",
  });
  // A native build name is numeric; the prerelease stays in what the app says.
  const prerelease = await readNativeMetadata(root, undefined, "0.8.0-rc.1");
  expect(prerelease.release).toBe("0.8.0-rc.1");
  expect(prerelease.app.versionName).toBe("0.8.0");
});

test("the repository carries no version of its own", async () => {
  // A second version in `pubspec.yaml` is the drift this replaced.
  const metadata = await readNativeMetadata(
    resolve(import.meta.dirname, ".."),
    undefined,
    "",
  );
  expect(metadata.app.versionName).toBe("0.0.0");
});

describe("malformed source metadata fails closed", () => {
  test("the pubspec version is a parsed YAML scalar with a build identity", async () => {
    await expect(
      readNativeMetadata(await fixture("development")),
    ).rejects.toThrow("version must be");
  });

  test("a release is a version tag without its v", async () => {
    const root = await fixture();
    for (const release of [
      "v0.7.163",
      "0.7",
      "0.7.163-",
      "0.7.163\n",
      "00.7.163",
    ]) {
      await expect(
        readNativeMetadata(root, undefined, release),
      ).rejects.toThrow("FROCKBOT_RELEASE must be");
    }
  });

  test("the hosted profile names a bare hostname", async () => {
    await expect(
      readNativeMetadata(
        await fixture("0.0.0+1", {
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
      }),
    ).rejects.toThrow("outside the supported 1..1 range");
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
    // The release scripts reach the tag through the environment they inherit.
    env: { ...process.env, FROCKBOT_RELEASE: "0.7.163" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(
    await readNativeMetadata(root, undefined, "0.7.163"),
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
