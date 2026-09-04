// Every Bot-authored Package failed to mount with `package "aud-usd" stored
// manifest failed hash verification`, deterministically, on byte-identical
// source. The mount hashed a *decoded* manifest against a hash taken over the
// *raw* one, so journey 4 step 2 — "use the tool you just built" — was
// impossible for anybody. First-party members mounted fine, because their
// reader already returned the raw document.
import { describe, expect, test } from "bun:test";
import { authoredManifestV1 } from "@frockbot/plugin-authoring/shared";
import {
  type CompositionMemberV1,
  decodeFrockBotManifest,
} from "@frockbot/kernel-composition";
import { botIsolatePackageDescriptorV1 } from "@frockbot/kernel-composition/isolate";
import { canonicalJson, sha256 } from "@frockbot/kernel-composition/compiler";

import {
  type CompositionManifestSourcesV1,
  compositionMemberManifestDocumentV1,
  compositionMemberManifestV1,
} from "./composition-manifest.js";

/** What `package_author` writes, exactly as `backend-authoring.ts` builds it. */
function authoredManifest(): unknown {
  return authoredManifestV1({
    packageId: "aud-usd",
    displayName: "AUD/USD",
    version: "0.0.1",
    tools: [
      {
        name: "aud_usd_rate",
        description: "The current AUD/USD rate.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
}

/** The durable store, as `authorship:manifest:<hash>` holds it. */
async function storedMember(): Promise<{
  member: CompositionMemberV1;
  manifest: unknown;
  sources: CompositionManifestSourcesV1;
}> {
  const manifest = authoredManifest();
  // The one hash that matters: taken over the raw document at authoring time.
  const manifestHash = await sha256(canonicalJson(manifest));
  const member: CompositionMemberV1 = {
    packageId: "aud-usd",
    version: "0.0.1",
    manifestHash,
    origin: "bot-authored",
    artifact: {
      contentHash: "b".repeat(64),
      size: 128,
      mediaType: "text/javascript",
    },
  } as CompositionMemberV1;
  const sources: CompositionManifestSourcesV1 = {
    stored: (hash) =>
      Promise.resolve(hash === manifestHash ? { manifest } : undefined),
    application: () => Promise.resolve(undefined),
  };
  return { member, manifest, sources };
}

describe("the manifest a mount is handed", () => {
  test("hashes to what the Composition member recorded", async () => {
    const { member, sources } = await storedMember();

    const document = await compositionMemberManifestDocumentV1(member, sources);
    const descriptor = await botIsolatePackageDescriptorV1(member, document);

    expect(descriptor.manifest.id).toBe("aud-usd");
    expect(descriptor.manifest.version).toBe("0.0.1");
  });

  test("is the stored document, not a rebuild of it", async () => {
    const { member, manifest, sources } = await storedMember();

    const document = await compositionMemberManifestDocumentV1(member, sources);

    expect(document).toBe(manifest);
  });

  test("decoding first is what broke it, and still would", async () => {
    // The guard this test exists for. `decodeFrockBotManifest` rebuilds the
    // object — `decodeV5` always writes a `configuration` key — so the decoded
    // manifest does not canonicalize back to the recorded hash. If the reader
    // ever decodes again, the test above fails and this one says why.
    const { member, manifest } = await storedMember();
    const decoded = decodeFrockBotManifest(manifest);

    expect(canonicalJson(decoded)).not.toBe(canonicalJson(manifest));
    await expect(
      botIsolatePackageDescriptorV1(member, decoded),
    ).rejects.toThrow("stored manifest failed hash verification");
  });

  test("the typed reader still answers the shape its callers want", async () => {
    const { member, sources } = await storedMember();

    const typed = await compositionMemberManifestV1(member, sources);

    expect(typed?.id).toBe("aud-usd");
    expect(typed?.version).toBe("0.0.1");
  });

  test("a member with no stored manifest falls back to the application's", async () => {
    const { member, manifest } = await storedMember();
    const document = await compositionMemberManifestDocumentV1(member, {
      stored: () => Promise.resolve(undefined),
      application: () => Promise.resolve(manifest),
    });

    expect(document).toBe(manifest);
  });
});
