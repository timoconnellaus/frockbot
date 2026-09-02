import { describe, expect, test } from "bun:test";
import {
  assertCompositionArtifactSetHashV1,
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
} from "./generation.ts";

const CREATED_AT = "2026-08-31T00:00:00.000Z";

function manifest(id: string) {
  return { id, version: "0.0.1", displayName: id };
}

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "tools",
        specifier: "@frockbot/plugin-tools",
        version: "0.0.1",
        manifest: manifest("tools"),
      },
      {
        packageId: "models",
        specifier: "@frockbot/plugin-models",
        version: "0.0.1",
        manifest: manifest("models"),
      },
    ],
    { createdAt: CREATED_AT },
  );
}

describe("Composition generation v1", () => {
  test("bootstraps one first-party generation from declared Contributions", async () => {
    const generation = await bootstrap();

    expect(generation.origin).toEqual({ kind: "bootstrap" });
    expect(generation.status).toBe("pending");
    expect(generation.createdAt).toBe(CREATED_AT);
    expect(generation.members.map((member) => member.packageId)).toEqual([
      "models",
      "tools",
    ]);
    expect(
      generation.members.every(
        (member) =>
          member.provenance.kind === "first-party" &&
          member.artifact === undefined,
      ),
    ).toBe(true);
    expect(generation.generationId.startsWith(`${CREATED_AT}:`)).toBe(true);
    await assertCompositionArtifactSetHashV1(generation);
  });

  test("keys the generation by its resolved artifact set", async () => {
    const first = await bootstrap();
    const second = await bootstrap();

    expect(second.artifactSetHash).toBe(first.artifactSetHash);
    expect(second.generationId).toBe(first.generationId);
    expect(
      await compositionArtifactSetHashV1([...first.members].reverse()),
    ).toBe(first.artifactSetHash);
  });

  test("the v1 codec rejects unknown fields", async () => {
    const generation = await bootstrap();

    expect(() =>
      decodeCompositionGenerationV1({ ...generation, extra: true }),
    ).toThrow("composition generation has invalid fields");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        members: [{ ...generation.members[0], extra: true }],
      }),
    ).toThrow("composition generation.members[0] has invalid fields");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        origin: { kind: "bootstrap", userId: "user-1" },
      }),
    ).toThrow("composition generation.origin has invalid fields");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        members: [
          {
            ...generation.members[0],
            provenance: {
              ...generation.members[0]!.provenance,
              authoredAt: CREATED_AT,
            },
          },
        ],
      }),
    ).toThrow(
      "composition generation.members[0].provenance has invalid fields",
    );
  });

  test("the v1 codec rejects malformed hashes and mismatched provenance", async () => {
    const generation = await bootstrap();

    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        artifactSetHash: "not-a-digest",
      }),
    ).toThrow("composition generation.artifactSetHash must be a sha-256 hex");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        artifactSetHash: generation.artifactSetHash.toUpperCase(),
      }),
    ).toThrow("composition generation.artifactSetHash must be a sha-256 hex");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        members: [{ ...generation.members[0], manifestHash: "abc" }],
      }),
    ).toThrow("composition generation.members[0].manifestHash");
    expect(() =>
      decodeCompositionGenerationV1({
        ...generation,
        members: [{ ...generation.members[0], version: "9.9.9" }],
      }),
    ).toThrow("does not match its member");
    expect(() =>
      decodeCompositionGenerationV1({ ...generation, status: "mounted" }),
    ).toThrow("composition generation.status is invalid");
    expect(() =>
      decodeCompositionGenerationV1({ ...generation, schemaVersion: 2 }),
    ).toThrow("composition generation.schemaVersion is unsupported");
  });

  test("rejects a generation whose recorded artifact set hash is wrong", async () => {
    const generation = await bootstrap();

    await expect(
      assertCompositionArtifactSetHashV1({
        ...generation,
        artifactSetHash: "b".repeat(64),
      }),
    ).rejects.toThrow("mismatched artifact set hash");
  });

  test("decodes an isolate member with its content-addressed artifact", async () => {
    const generation = await bootstrap();
    const members = [
      {
        packageId: "authored",
        specifier: "bot://authored",
        version: "0.0.1",
        manifestHash: "c".repeat(64),
        provenance: {
          kind: "bot" as const,
          packageId: "authored",
          version: "0.0.1",
          botId: "primary",
          sessionId: "user-1:primary",
          turnId: "turn-1",
          runId: "run-1",
          authoredAt: CREATED_AT,
        },
        artifact: {
          contentHash: "d".repeat(64),
          size: 1024,
          mediaType: "application/javascript" as const,
          bundlerVersion: "0.2.3",
        },
      },
    ];
    const decoded = decodeCompositionGenerationV1({
      ...generation,
      artifactSetHash: await compositionArtifactSetHashV1(members),
      members,
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: "user-1:primary",
        turnId: "turn-1",
      },
    });

    expect(decoded.members[0]?.artifact?.contentHash).toBe("d".repeat(64));
    await assertCompositionArtifactSetHashV1(decoded);
    expect(() =>
      decodeCompositionGenerationV1({
        ...decoded,
        members: [
          {
            ...members[0],
            artifact: { ...members[0]!.artifact, mediaType: "text/plain" },
          },
        ],
      }),
    ).toThrow("mediaType is invalid");
  });

  test("decodes a Catalog isolate member and its plain-language generation summary", async () => {
    const generation = await bootstrap();
    const member = {
      packageId: "parcel-tracking",
      specifier: "catalog:parcel-tracking",
      version: "0.0.1",
      manifestHash: "c".repeat(64),
      provenance: {
        kind: "catalog" as const,
        packageId: "parcel-tracking",
        version: "0.0.1",
        catalogId: "parcel-tracking",
        catalogGeneration: "catalog-1",
        contentHash: "d".repeat(64),
      },
      artifact: {
        contentHash: "d".repeat(64),
        size: 512,
        mediaType: "application/javascript" as const,
        bundlerVersion: "catalog-test@1",
      },
    };
    const decoded = decodeCompositionGenerationV1({
      ...generation,
      members: [member],
      artifactSetHash: await compositionArtifactSetHashV1([member]),
      origin: {
        kind: "bot-catalog",
        action: "install",
        packageId: "parcel-tracking",
        catalogId: "parcel-tracking",
        botId: "primary",
        runId: "run-1",
        sessionId: "user-1:primary",
        turnId: "turn-1",
      },
      summary: "Added parcel tracking",
    });

    expect(decoded.summary).toBe("Added parcel tracking");
    expect(decoded.members[0]?.provenance.kind).toBe("catalog");
    expect(() =>
      decodeCompositionGenerationV1({
        ...decoded,
        members: [{ ...member, artifact: undefined }],
      }),
    ).toThrow("must match its Bot-isolate artifact");
    expect(() =>
      decodeCompositionGenerationV1({
        ...decoded,
        summary: "Added\nparcel tracking",
      }),
    ).toThrow("must be one trimmed line");
  });
});
