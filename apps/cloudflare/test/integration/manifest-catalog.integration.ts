// Seam S6: the `/app-manifest` producer in `src/user-application.ts` against
// the client decoder in `packages/plugin-shell/src/client/index.ts`.
//
// Both halves were tested, never against each other, and two incidents lived
// in exactly that gap:
//
//   Incident 2 — the decoder rejected the manifest whenever
//     `deployment.applicationHash !== applicationHash`. Those two are different
//     things by construction (the artifact bytes the gateway loaded, and the
//     compiled plan's digest), so the live manifest never satisfied it.
//   Incident 3 — the decoder's per-Package field check did not allow the
//     optional `configuration` key, so every Package that declares
//     configuration was refused.
//
// This test decodes the live body with the production decoder, imported, not
// copied.
import { describe, expect, it } from "vitest";
import { decodePluginCatalog } from "@frockbot/plugin-shell/client";
import { asUser, freshUserId, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

describe("the live application manifest decodes with the client's decoder", () => {
  it("is accepted by decodePluginCatalog, configuration and all", async () => {
    const userId = freshUserId("manifest");
    const response = await asUser(userId, "/app-manifest");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployment: { applicationHash: string };
      applicationHash: string;
      packages: Array<{ id: string; configuration?: unknown }>;
    };

    // The two hashes name different things and are never equal in a real
    // deployment; a decoder that compares them refuses every live manifest.
    expect(body.deployment.applicationHash).not.toBe(body.applicationHash);

    // The manifest must actually contain both shapes, or the decode below
    // proves nothing about the optional key.
    const withConfiguration = body.packages.filter((pkg) =>
      Object.hasOwn(pkg, "configuration"),
    );
    const withoutConfiguration = body.packages.filter(
      (pkg) => !Object.hasOwn(pkg, "configuration"),
    );
    expect(withConfiguration.length).toBeGreaterThan(0);
    expect(withoutConfiguration.length).toBeGreaterThan(0);

    // The decoder keeps only Packages the Plugins surface can install or
    // assign — the ones that declare a Connection Type or a Capability — so
    // the provider Package must survive, and it is one of the Packages that
    // carries `configuration`.
    const catalog = decodePluginCatalog(body);
    const provider = catalog.find(
      (item) => item.packageId === "provider-ollama-cloud",
    );
    expect(provider).toBeDefined();
    expect(provider?.connectionTypes.map((type) => type.id)).toContain(
      "ollama-cloud-account",
    );
    expect(withConfiguration.map((pkg) => pkg.id)).toContain(
      "provider-ollama-cloud",
    );
  });
});
