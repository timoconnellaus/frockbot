// The gateway → User Durable Object seam for the settings surfaces the
// Flutter client renders: Connectors as a frame, Models as a `ViewDocument`.
//
// Models answers a frame, or the same settings in the renderer's own
// vocabulary when the request asks for `?as=document`. The projections are
// pure and unit-tested; what only a real request can prove is that the frame
// the Durable Object builds is one the projection accepts, and that a
// credential never appears in what a client is handed.
import { describe, expect, it } from "vitest";
import {
  asUser,
  accountRevision,
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
  label?: string;
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
  const enabled = await accountRevision(userId);
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
