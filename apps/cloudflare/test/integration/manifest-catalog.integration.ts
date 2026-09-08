// Seam S6: the `/app-manifest` producer in `src/user-application.ts`, against
// the shapes the Plugins surface reads out of it.
//
// Both halves were tested, never against each other, and an incident lived in
// exactly that gap:
//
//   Incident 3 — the consumer's per-Package field check did not allow the
//     optional keys, so every Package that declares configuration was
//     refused.
//
// The consumer is now a server-side projection (`app/settings/plugins-
// document.ts`), so what this proves is that the live body still carries every
// shape that projection distinguishes: a Package with configuration and one
// without, a Connection Type, a Capability with no Connection, settings with
// no Capability, and the platform-owned mark that keeps the app's own shell
// out of an enablement surface.
import { describe, expect, it } from "vitest";
import { asUser, freshUserId, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

interface ManifestPackageV1 {
  id: string;
  displayName: string;
  platformOwned?: boolean;
  settings?: { id: string; scopes: string[]; role?: string }[];
  capabilities?: { id: string }[];
  connectionTypes?: { id: string }[];
}

describe("the live application manifest", () => {
  it("carries every Package shape the Plugins surface distinguishes", async () => {
    const userId = freshUserId("manifest");
    const response = await asUser(userId, "/app-manifest");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployment: { applicationHash: string };
      packages: ManifestPackageV1[];
    };

    expect(body.deployment.applicationHash.length).toBeGreaterThan(0);

    const configured = (pkg: ManifestPackageV1) =>
      Object.hasOwn(pkg, "settings") ||
      Object.hasOwn(pkg, "capabilities") ||
      Object.hasOwn(pkg, "connectionTypes");
    const withConfiguration = body.packages.filter(configured);
    const withoutConfiguration = body.packages.filter(
      (pkg) => !configured(pkg),
    );
    expect(withConfiguration.length).toBeGreaterThan(0);
    expect(withoutConfiguration.length).toBeGreaterThan(0);

    const find = (id: string) => body.packages.find((pkg) => pkg.id === id);

    // A provider Package carries its Connection Type, which is what a
    // Connectors row is built from.
    const provider = find("provider-ollama-cloud");
    expect(provider?.connectionTypes?.map((type) => type.id)).toContain(
      "ollama-cloud-account",
    );
    expect(withConfiguration.map((pkg) => pkg.id)).toContain(
      "provider-ollama-cloud",
    );

    // A Package whose only Capability is a tool that takes no Connection is
    // still something a User enables, so it declares one and no Connection.
    const flock = find("flock");
    expect(flock?.capabilities?.map((capability) => capability.id)).toContain(
      "bot-self-management",
    );
    expect(flock?.connectionTypes).toBeUndefined();
    // A Package the User does choose carries no ownership mark.
    expect(flock?.platformOwned).toBeUndefined();

    // Custom models deliberately contributes settings with no Capability and
    // no Connection Type. Its enablement is what makes the retained settings
    // active, so that legitimate Package shape must remain visible.
    const customModels = find("custom-models");
    expect(customModels?.displayName).toBe("Custom models");
    expect(customModels?.capabilities).toBeUndefined();
    expect(customModels?.connectionTypes).toBeUndefined();
    expect(
      customModels?.settings?.map((setting) => [
        setting.id,
        setting.scopes,
        setting.role,
      ]),
    ).toEqual([["model", ["bot"], "model"]]);

    // The application's own shell is projected so model resolution sees every
    // manifest, but marked platform-owned so no enablement surface offers it.
    expect(find("shell")?.platformOwned).toBe(true);
  });
});
