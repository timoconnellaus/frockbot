import { describe, expect, test } from "bun:test";
import type { PackagePublisherTransaction } from "@frockbot/plugin-package-publisher/user";
import type { LoadedWorker, WorkerCode, WorkerLoader } from "./contracts.js";
import { createPackagePublicationHost } from "./package-publication.js";

class MemoryBucket {
  readonly values = new Map<string, string>();

  get(key: string) {
    const value = this.values.get(key);
    return Promise.resolve(
      value === undefined
        ? null
        : {
            text: () => Promise.resolve(value),
          },
    );
  }

  put(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve({});
  }
}

class VerifyingLoader implements WorkerLoader {
  ids: string[] = [];
  code?: WorkerCode;

  constructor(private readonly validManifest = true) {}

  get(id: string, callback: () => Promise<WorkerCode>): LoadedWorker {
    this.ids.push(id);
    return {
      getEntrypoint: () => ({
        fetch: async (request) => {
          this.code = await callback();
          const path = new URL(request.url).pathname;
          if (path === "/app-manifest") {
            if (!this.validManifest) {
              return Response.json({ deployment: this.code.env.DEPLOYMENT });
            }
            return Response.json({
              schemaVersion: 1,
              deployment: this.code.env.DEPLOYMENT,
              applicationHash: "sha256:foundation-plan",
              packages: [
                {
                  id: "package-publisher",
                  displayName: "Package Publisher",
                  version: "0.0.1",
                  contributions: ["backend", "runtime", "client"],
                },
              ],
            });
          }
          const contentType =
            path === "/"
              ? "text/html"
              : path === "/app.js"
                ? "text/javascript"
                : "text/css";
          return new Response("healthy", {
            headers: { "content-type": contentType },
          });
        },
      }),
    };
  }
}

class MemoryStorage implements PackagePublisherTransaction {
  get<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }

  put<T>(_key: string, _value: T): Promise<void> {
    return Promise.resolve();
  }

  transaction<T>(
    callback: (value: PackagePublisherTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

const storage = new MemoryStorage();

describe("Cloudflare package publication effects", () => {
  test("stores source and exact artifact immutably before health verification", async () => {
    const bucket = new MemoryBucket();
    const loader = new VerifyingLoader();
    const host = createPackagePublicationHost(
      {
        APPLICATION_ARTIFACTS: bucket as unknown as R2Bucket,
        USER_APPLICATIONS: loader,
      },
      storage,
    );
    const candidate = {
      source: "git source snapshot",
      applicationArtifact: "export default { fetch() {} }",
      checks: [{ name: "test", status: "passed" as const }],
    };
    const applicationHash = await host.hash(candidate);

    await host.storeAndVerify({
      userId: "user-1",
      applicationHash,
      candidate,
    });
    await host.storeAndVerify({
      userId: "user-1",
      applicationHash,
      candidate,
    });

    expect(applicationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bucket.values).toEqual(
      new Map([
        [`applications/${applicationHash}.mjs`, candidate.applicationArtifact],
        [`application-sources/${applicationHash}.txt`, candidate.source],
      ]),
    );
    expect(loader.ids).toEqual([
      `verify:user-1:${applicationHash}`,
      `verify:user-1:${applicationHash}`,
    ]);
    expect(loader.code?.globalOutbound).toBeUndefined();
  });

  test("rejects an artifact that only echoes the deployment identity", async () => {
    const host = createPackagePublicationHost(
      {
        APPLICATION_ARTIFACTS: new MemoryBucket() as unknown as R2Bucket,
        USER_APPLICATIONS: new VerifyingLoader(false),
      },
      storage,
    );
    const candidate = {
      source: "git source snapshot",
      applicationArtifact: "export default { fetch() {} }",
      checks: [{ name: "test", status: "passed" as const }],
    };

    await expect(
      host.storeAndVerify({
        userId: "user-1",
        applicationHash: await host.hash(candidate),
        candidate,
      }),
    ).rejects.toThrow("invalid manifest");
  });
});
