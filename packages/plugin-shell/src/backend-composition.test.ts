import { describe, expect, test } from "bun:test";
import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import {
  bootstrapCompositionGeneration,
  resolveDeploymentCompositionV1,
  DEPLOYMENT_FOLLOW_SUMMARY_V1,
} from "./backend-composition.js";

const ARTIFACT_A = {
  contentHash: "a".repeat(64),
  size: 10,
  mediaType: "application/javascript" as const,
  bundlerVersion: "1",
};
const ARTIFACT_B = { ...ARTIFACT_A, contentHash: "b".repeat(64) };

/** A compiled application: the shell in-process, the Applets as an artifact. */
function plan(input: {
  appletsManifest: unknown;
  appletsArtifact?: typeof ARTIFACT_A;
  extra?: boolean;
}): ApplicationPlan {
  return {
    packages: [
      {
        id: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "1.0.0",
        manifest: { id: "shell" },
      },
      {
        id: "applets",
        specifier: "@frockbot/plugin-applets",
        version: "1.0.0",
        manifest: input.appletsManifest,
        artifact: input.appletsArtifact ?? ARTIFACT_A,
      },
      ...(input.extra
        ? [
            {
              id: "extra",
              specifier: "@frockbot/plugin-extra",
              version: "1.0.0",
              manifest: { id: "extra" },
            },
          ]
        : []),
    ],
  } as unknown as ApplicationPlan;
}

function store(current: CompositionGenerationV1) {
  const proposed: CompositionGenerationV1[] = [];
  return {
    proposed,
    current: () => Promise.resolve(current),
    propose: (generation: CompositionGenerationV1) => {
      proposed.push(generation);
      return Promise.resolve();
    },
  };
}

/** The generation a Bot pinned under yesterday's deployment, plus a User member. */
async function pinned(
  deployment: ApplicationPlan,
  extraMembers: CompositionMemberV1[] = [],
): Promise<CompositionGenerationV1> {
  const bootstrap = await bootstrapCompositionGeneration(
    deployment,
    "2026-09-04T09:00:00.000Z",
  );
  const members = [...bootstrap.members, ...extraMembers].sort((a, b) =>
    a.packageId.localeCompare(b.packageId),
  );
  const applets = [
    {
      kind: "applet" as const,
      appletId: "user-1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      generationId: "g1",
      tools: [
        {
          name: "add_todo",
          description: "Add",
          inputSchema: { type: "object" },
        },
      ],
      provenance: {
        kind: "user" as const,
        packageId: "user-1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version: "g1",
        userId: "user-1",
        authoredAt: "2026-09-04T09:00:00.000Z",
      },
    },
  ];
  const artifactSetHash = await compositionArtifactSetHashV1(members, applets);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-04T09:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-04T09:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    applets,
    status: "active",
  });
}

const USER_MEMBER: CompositionMemberV1 = {
  packageId: "user-1.notes",
  specifier: "frockbot:user-1.notes",
  version: "3",
  manifestHash: "d".repeat(64),
  provenance: {
    kind: "user",
    packageId: "user-1.notes",
    version: "3",
    userId: "user-1",
    authoredAt: "2026-09-04T10:00:00.000Z",
  },
  artifact: { ...ARTIFACT_A, contentHash: "e".repeat(64) },
};

describe("a Bot's built-in members follow the deployment", () => {
  test("an unchanged deployment proposes nothing", async () => {
    const yesterday = plan({ appletsManifest: { id: "applets", v: 1 } });
    const composition = store(await pinned(yesterday, [USER_MEMBER]));
    const result = await resolveDeploymentCompositionV1({
      plan: yesterday,
      composition,
      now: new Date("2026-09-05T07:30:00.000Z"),
    });
    expect(result).toBeUndefined();
    expect(composition.proposed).toHaveLength(0);
  });

  test("a changed manifest or artifact is a new pinned generation with the old one as parent", async () => {
    const yesterday = plan({ appletsManifest: { id: "applets", v: 1 } });
    const current = await pinned(yesterday, [USER_MEMBER]);
    const composition = store(current);
    const today = plan({
      appletsManifest: { id: "applets", v: 2 },
      appletsArtifact: ARTIFACT_B,
    });
    const result = await resolveDeploymentCompositionV1({
      plan: today,
      composition,
      now: new Date("2026-09-05T07:30:00.000Z"),
    });
    expect(result).toBeDefined();
    expect(composition.proposed).toEqual([result!]);
    expect(result!.status).toBe("pending");
    expect(result!.parentGenerationId).toBe(current.generationId);
    expect(result!.summary).toBe(DEPLOYMENT_FOLLOW_SUMMARY_V1);
    const deployed = await bootstrapCompositionGeneration(
      today,
      result!.createdAt,
    );
    const applets = result!.members.find((m) => m.packageId === "applets");
    expect(applets).toEqual(
      deployed.members.find((m) => m.packageId === "applets"),
    );
    // The shell did not change, the User's own member is carried over
    // untouched, and the Applet members stay pinned.
    expect(result!.members.find((m) => m.packageId === "shell")).toEqual(
      current.members.find((m) => m.packageId === "shell"),
    );
    expect(result!.members.find((m) => m.packageId === "user-1.notes")).toEqual(
      USER_MEMBER,
    );
    expect(result!.applets).toEqual(current.applets);
    expect(result!.artifactSetHash).toBe(
      await compositionArtifactSetHashV1(result!.members, result!.applets),
    );
  });

  test("a built-in Package the deployment added or dropped changes the set", async () => {
    const yesterday = plan({ appletsManifest: { id: "applets", v: 1 } });
    const composition = store(await pinned(yesterday));
    const today = plan({
      appletsManifest: { id: "applets", v: 1 },
      extra: true,
    });
    const added = await resolveDeploymentCompositionV1({
      plan: today,
      composition,
    });
    expect(added!.members.map((m) => m.packageId)).toEqual([
      "applets",
      "extra",
      "shell",
    ]);

    const dropped = await resolveDeploymentCompositionV1({
      plan: yesterday,
      composition: store(await pinned(today)),
    });
    expect(dropped!.members.map((m) => m.packageId)).toEqual([
      "applets",
      "shell",
    ]);
  });

  test("a version bump alone does not spend a generation", async () => {
    const yesterday = plan({ appletsManifest: { id: "applets", v: 1 } });
    const composition = store(await pinned(yesterday));
    const bumped = {
      packages: yesterday.packages.map((pkg) => ({ ...pkg, version: "1.0.1" })),
    } as unknown as ApplicationPlan;
    expect(
      await resolveDeploymentCompositionV1({ plan: bumped, composition }),
    ).toBeUndefined();
  });
});
