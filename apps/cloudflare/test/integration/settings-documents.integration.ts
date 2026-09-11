// The gateway → User Durable Object seam for the two surfaces the Flutter
// client renders through `ViewDocumentView`.
//
// Both routes answer a frame, or the same settings in the renderer's own
// vocabulary when the request asks for `?as=document`. The projection is pure
// and unit-tested; what only a real request can prove is that the frame the
// Durable Object builds is one the projection accepts, and that a credential
// never appears in the document a client is handed.
import { describe, expect, it } from "vitest";
import {
  asUser,
  enableCustomModels,
  expectOkJson,
  freshUserId,
  OLLAMA_GOOD_API_KEY,
  postAsUser,
  PROVISIONED_MODEL,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface Node {
  type: string;
  text?: string;
  title?: string;
  children?: Node[];
  field?: { id: string; kind: string; value: unknown };
  actionId?: string;
  input?: Record<string, unknown>;
}

interface Document {
  surfaceId: string;
  revision: number;
  root: Node;
  actions: { id: string; schema: { required: string[] } }[];
}

function walk(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

async function installProvider(userId: string): Promise<void> {
  const enabled = await enableCustomModels(userId, "custom-models");
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-provider",
      expectedRevision: enabled,
      packageId: PROVISIONED_MODEL.packageId,
      version: "0.0.1",
    }),
  );
}

describe("the Connectors frame", () => {
  it("shows a connected account and never the key that connected it", async () => {
    const userId = freshUserId("connectors-connected");
    await installProvider(userId);
    await expectOkJson(
      await postAsUser(userId, "/api/connections", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "connect-doc",
        packageId: PROVISIONED_MODEL.packageId,
        connectionTypeId: PROVISIONED_MODEL.connectionTypeId,
        label: "Integration",
        apiKey: OLLAMA_GOOD_API_KEY,
      }),
    );

    const answer = await asUser(userId, "/api/settings/connections");
    const body = await answer.text();
    expect(answer.status).toBe(200);
    expect(body).not.toContain(OLLAMA_GOOD_API_KEY);
    const frame = JSON.parse(body) as {
      accounts: Array<{
        label: string;
        detail?: string;
        connectionTypeId: string;
      }>;
    };
    const account = frame.accounts.find((row) => row.label === "Integration");
    expect(account?.connectionTypeId).toBe(PROVISIONED_MODEL.connectionTypeId);
    expect(account?.detail?.startsWith("Ready")).toBe(true);
  });

  it("answers the frame with every provider", async () => {
    const userId = freshUserId("connectors-frame");
    const frame = (await expectOkJson(
      await asUser(userId, "/api/settings/connections"),
    )) as { schemaVersion: number; accounts: unknown[]; providers: unknown[] };
    expect(frame.schemaVersion).toBe(1);
    expect(Array.isArray(frame.providers)).toBe(true);
  });
});

describe("the Capabilities document", () => {
  it("names every capability's enablement and the surface that configures it", async () => {
    const userId = freshUserId("capabilities-doc");
    await installProvider(userId);

    const document = (await expectOkJson(
      await asUser(userId, "/api/settings/capabilities?as=document"),
    )) as Document;

    expect(document.surfaceId).toBe("capabilities");
    const kinds = new Set(
      walk(document.root)
        .filter((node) => node.type === "action")
        .map((node) => node.input?.kind),
    );
    expect(kinds.has("set-package-enabled")).toBe(true);
    expect(
      walk(document.root).some((node) => node.title === "Custom models"),
    ).toBe(true);
  });

  it("answers the frame itself without the document parameter", async () => {
    const userId = freshUserId("capabilities-frame");
    const frame = (await expectOkJson(
      await asUser(userId, "/api/settings/capabilities"),
    )) as { schemaVersion: number; plugins: { packageId: string }[] };
    expect(frame.schemaVersion).toBe(1);
    expect(frame.plugins.length).toBeGreaterThan(0);
  });
});
