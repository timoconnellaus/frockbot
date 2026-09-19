import { describe, expect, test } from "bun:test";
import { ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 } from "@frockbot/core/contracts";
import {
  loadManagedSkillsV1,
  MANAGED_SKILL_DOCUMENTS_V1,
  type ManagedSkillDocumentV1,
} from "./managed.js";
import { loadPluginSkillsV1 } from "./plugin.js";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_REFERENCES } from "./skill-md.js";
import { skillMarkdown } from "./testing.js";

const DOCUMENT = skillMarkdown(
  "Draft an email",
  "Use this when the User wants an email drafted.",
  "Body.",
);

const adapters = [
  {
    source: "managed",
    load: (documents: readonly ManagedSkillDocumentV1[]) =>
      loadManagedSkillsV1(documents),
  },
  {
    source: "plugin",
    load: (documents: readonly ManagedSkillDocumentV1[]) =>
      loadPluginSkillsV1([
        {
          pluginId: "email-card",
          displayName: "Email",
          skills: documents.map((document) => ({
            ...document,
            references: document.references?.map((reference) => ({
              ...reference,
            })),
          })),
        },
      ]),
  },
] as const;

function documentOfBytes(size: number): string {
  const base = skillMarkdown("Bounded", "Use this when testing.", "x");
  if (base.length > size) throw new Error("test document size is too small");
  return `${base}${"x".repeat(size - base.length)}`;
}

describe("artifact Skill adapters", () => {
  test("preserve their source identity and attribution", async () => {
    const [managed, plugin] = await Promise.all([
      adapters[0].load([
        {
          slug: "drafting",
          text: DOCUMENT,
          references: [{ path: "forms.md", text: "# Forms" }],
        },
      ]),
      adapters[1].load([
        {
          slug: "drafting",
          text: DOCUMENT,
          references: [{ path: "forms.md", text: "# Forms" }],
        },
      ]),
    ]);

    expect(managed.skills[0]).toMatchObject({
      path: "managed/drafting/SKILL.md",
      source: "managed",
      ref: { schemaVersion: 1, source: "managed", slug: "drafting" },
      by: "FrockBot",
      references: [
        {
          path: "managed/drafting/references/forms.md",
          by: "FrockBot",
        },
      ],
    });
    expect(plugin.skills[0]).toMatchObject({
      path: "plugin/email-card/drafting/SKILL.md",
      source: "plugin",
      ref: {
        schemaVersion: 1,
        source: "plugin",
        pluginId: "email-card",
        slug: "drafting",
      },
      by: 'Plugin "Email"',
      references: [
        {
          path: "plugin/email-card/drafting/references/forms.md",
          by: 'Plugin "Email"',
        },
      ],
    });
  });

  test("enforce one validation corpus", async () => {
    const corpus = [
      {
        name: "slug",
        document: { slug: "Drafting", text: DOCUMENT },
        refusal: { kind: "malformed", reason: "not a well-formed slug" },
      },
      {
        name: "frontmatter name",
        document: {
          slug: "drafting",
          text: skillMarkdown(
            "x".repeat(65),
            "Use this when testing.",
            "Body.",
          ),
        },
        refusal: { kind: "malformed", reason: "needs a bounded name" },
      },
      {
        name: "document file size",
        document: {
          slug: "drafting",
          text: documentOfBytes(SKILL_MAX_FILE_BYTES + 1),
        },
        refusal: {
          kind: "malformed",
          reason: `SKILL.md exceeds ${SKILL_MAX_FILE_BYTES} bytes`,
        },
      },
      {
        name: "reference name before size",
        document: {
          slug: "drafting",
          text: DOCUMENT,
          references: [
            {
              path: "../large.md",
              text: "x".repeat(SKILL_MAX_FILE_BYTES + 1),
            },
          ],
        },
        refusal: { kind: "malformed", reason: "not a single .md file name" },
      },
      {
        name: "reference file size",
        document: {
          slug: "drafting",
          text: DOCUMENT,
          references: [
            {
              path: "large.md",
              text: "x".repeat(SKILL_MAX_FILE_BYTES + 1),
            },
          ],
        },
        refusal: {
          kind: "oversized",
          reason: `${SKILL_MAX_FILE_BYTES + 1} bytes`,
        },
      },
      {
        name: "reference count",
        document: {
          slug: "drafting",
          text: DOCUMENT,
          references: Array.from(
            { length: SKILL_MAX_REFERENCES + 1 },
            (_, index) => ({ path: `r${index}.md`, text: "#" }),
          ),
        },
        refusal: { kind: "oversized", reason: "offers 33 references" },
      },
    ] as const;

    for (const adapter of adapters) {
      for (const entry of corpus) {
        const loaded = await adapter.load([entry.document]);
        expect(loaded.skills, `${adapter.source}: ${entry.name}`).toEqual([]);
        expect(
          loaded.refusals[0],
          `${adapter.source}: ${entry.name}`,
        ).toMatchObject({ kind: entry.refusal.kind });
        expect(
          loaded.refusals[0]?.reason,
          `${adapter.source}: ${entry.name}`,
        ).toContain(entry.refusal.reason);
      }
    }
  });

  test("admit the aggregate boundary and refuse one byte beyond it", async () => {
    const atBoundary = {
      slug: "bounded",
      text: documentOfBytes(SKILL_MAX_FILE_BYTES),
      references: Array.from({ length: 3 }, (_, index) => ({
        path: `r${index}.md`,
        text: "x".repeat(SKILL_MAX_FILE_BYTES),
      })),
    };
    const overBoundary = {
      ...atBoundary,
      references: [...atBoundary.references, { path: "extra.md", text: "x" }],
    };

    for (const adapter of adapters) {
      const admitted = await adapter.load([atBoundary]);
      expect(admitted.refusals, adapter.source).toEqual([]);
      expect(admitted.skills, adapter.source).toHaveLength(1);

      const refused = await adapter.load([overBoundary]);
      expect(refused.skills, adapter.source).toEqual([]);
      expect(refused.refusals[0], adapter.source).toMatchObject({
        kind: "oversized",
        reason: expect.stringContaining(
          `the bound is ${ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1}`,
        ),
      });
    }
  });

  test("keeps the managed built-ins inside the aggregate artifact bound", () => {
    const encoder = new TextEncoder();
    const total = MANAGED_SKILL_DOCUMENTS_V1.reduce(
      (bytes, document) =>
        bytes +
        encoder.encode(document.text).byteLength +
        (document.references ?? []).reduce(
          (referenceBytes, reference) =>
            referenceBytes + encoder.encode(reference.text).byteLength,
          0,
        ),
      0,
    );
    expect(total).toBeLessThanOrEqual(ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1);
  });
});
