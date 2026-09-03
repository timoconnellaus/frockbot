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
      packages: Array<{
        id: string;
        configuration?: unknown;
        platformOwned?: boolean;
      }>;
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

    // The decoder keeps only Packages the Plugins surface can enable — the
    // ones that declare settings, a Connection Type or a Capability — so the
    // provider Package must survive, and it is one of the Packages that
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

    // A Package whose only Capability is a tool that takes no Connection is
    // still something a User installs and assigns, so it stays in the catalog.
    const flock = catalog.find((item) => item.packageId === "flock");
    expect(flock?.capabilities.map((capability) => capability.id)).toContain(
      "bot-self-management",
    );
    expect(flock?.connectionTypes).toEqual([]);

    // Custom models deliberately contributes settings and client sections,
    // with no Capability or Connection Type. Its enablement is what makes the
    // retained settings active, so that legitimate Package shape must remain
    // visible in Plugins.
    const customModels = catalog.find(
      (item) => item.packageId === "custom-models",
    );
    expect(customModels).toMatchObject({
      displayName: "Custom models",
      capabilities: [],
      connectionTypes: [],
    });
    expect(
      customModels?.settings?.map((setting) => [
        setting.id,
        setting.scopes,
        setting.role,
      ]),
    ).toEqual([
      ["account-model", ["user"], "model"],
      ["model", ["bot"], "model"],
    ]);

    // The application's own shell is mounted unconditionally: it is projected
    // so model resolution sees every manifest, but marked platform-owned so no
    // enablement surface offers it as a choice.
    const shell = body.packages.find((pkg) => pkg.id === "shell");
    expect(shell?.platformOwned).toBe(true);
    expect(
      catalog.find((item) => item.packageId === "shell")?.platformOwned,
    ).toBe(true);
    // A Package the User does choose carries no ownership mark.
    expect(flock?.platformOwned).toBeUndefined();
  });
});
