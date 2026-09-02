// The scrub matrix, row by row.
//
// Each `it` below is one row of the table in the slice plan, and the assertion
// is the whole contract for that row: what reaches the template, and what the
// summary says was left behind. The suite also carries the two negative
// contracts from register line 326 — a Skill whose body failed to load is
// dropped rather than re-read, and the scrub never touches the source.
import { describe, expect, it } from "bun:test";
import {
  buildBotTemplateV1,
  describeTemplateSummaryV1,
  shareableServerUrlV1,
  templateSlugV1,
  type TemplateSourceV1,
} from "./scrub.ts";
import type { TemplateOmissionReasonV1 } from "./shared.ts";

const sheep = {
  schemaVersion: 1 as const,
  background: "meadow",
  upper: "wool",
  middle: "scarf",
  lower: "boots",
};

function source(overrides: Partial<TemplateSourceV1> = {}): TemplateSourceV1 {
  return {
    botId: "budget",
    profile: { name: "Budget", title: "Money minder" },
    sheep,
    skills: [],
    routines: [],
    packages: [],
    connections: [],
    ...overrides,
  };
}

function omitted(
  summary: { omitted: { reason: TemplateOmissionReasonV1; count: number }[] },
  reason: TemplateOmissionReasonV1,
): number {
  return summary.omitted.find((entry) => entry.reason === reason)?.count ?? 0;
}

describe("skills", () => {
  it("carries an own-root Skill body verbatim", () => {
    const { template } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "bot",
            slug: "reconcile",
            name: "Reconcile",
            description: "Match the ledger",
            body: "# Reconcile\nOpen the ledger.",
            writer: { kind: "bot" },
          },
        ],
      }),
    );
    expect(template.skills).toEqual([
      {
        slug: "reconcile",
        name: "Reconcile",
        description: "Match the ledger",
        body: "# Reconcile\nOpen the ledger.",
      },
    ]);
  });

  it("carries an own-root Skill its User wrote", () => {
    const { template } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "bot",
            slug: "notes",
            name: "Notes",
            body: "body",
            writer: { kind: "user" },
          },
        ],
      }),
    );
    expect(template.skills).toHaveLength(1);
  });

  it("omits a managed Skill", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "managed",
            slug: "managed-one",
            name: "Managed",
            body: "body",
            writer: { kind: "first-party" },
          },
        ],
      }),
    );
    expect(template.skills).toEqual([]);
    expect(omitted(summary, "managed-skill")).toBe(1);
  });

  it("omits a plugin-borne Skill", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "plugin",
            slug: "plugin-one",
            name: "Plugin",
            body: "body",
            writer: { kind: "first-party" },
          },
        ],
      }),
    );
    expect(template.skills).toEqual([]);
    expect(omitted(summary, "plugin-skill")).toBe(1);
  });

  it("omits an own-root Skill with no recorded writer", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "bot",
            slug: "shell-written",
            name: "Shell",
            body: "body",
            writer: { kind: "unattributed" },
          },
        ],
      }),
    );
    expect(template.skills).toEqual([]);
    expect(omitted(summary, "unattributed-skill")).toBe(1);
  });

  it("drops a Skill whose body failed to load and never re-reads it", () => {
    const input = source({
      skills: [
        {
          source: "bot",
          slug: "broken",
          name: "Broken",
          writer: { kind: "bot" },
        },
        {
          source: "bot",
          slug: "good",
          name: "Good",
          body: "body",
          writer: { kind: "bot" },
        },
      ],
    });
    const { template, summary } = buildBotTemplateV1(input);
    expect(template.skills.map((skill) => skill.slug)).toEqual(["good"]);
    expect(omitted(summary, "unreadable-skill")).toBe(1);
  });

  it("scrubs while building the pack, never by editing the Bot", () => {
    const input = source({
      profile: { name: "Budget" },
      skills: [
        {
          source: "managed",
          slug: "managed-one",
          name: "Managed",
          body: "body",
          writer: { kind: "first-party" },
        },
      ],
      packages: [
        {
          packageId: "mcp",
          version: "0.0.1",
          state: "installed",
          values: { apiKey: "sk-live-do-not-share" },
        },
      ],
    });
    const before = structuredClone(input);
    buildBotTemplateV1(input);
    expect(input).toEqual(before);
  });

  it("gives two Skills with the same derived slug distinct slugs", () => {
    const { template } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "bot",
            name: "Daily note",
            body: "a",
            writer: { kind: "bot" },
          },
          {
            source: "bot",
            name: "Daily note",
            body: "b",
            writer: { kind: "bot" },
          },
        ],
      }),
    );
    expect(template.skills.map((skill) => skill.slug)).toEqual([
      "daily-note",
      "daily-note-2",
    ]);
  });
});

describe("routines", () => {
  it("carries a cron Routine with its schedule and time zone", () => {
    const { template } = buildBotTemplateV1(
      source({
        routines: [
          {
            routineId: "r-1",
            name: "Morning ledger",
            prompt: "Reconcile yesterday.",
            schedule: "0 9 * * *",
            timezone: "Australia/Sydney",
          },
        ],
      }),
    );
    expect(template.routines).toEqual([
      {
        slug: "morning-ledger",
        name: "Morning ledger",
        prompt: "Reconcile yesterday.",
        schedule: "0 9 * * *",
        timezone: "Australia/Sydney",
        triggerKind: "cron",
      },
    ]);
  });

  it("carries a webhook Routine as a trigger kind and no key or digest", () => {
    const { template } = buildBotTemplateV1(
      source({
        routines: [
          {
            routineId: "r-2",
            name: "On delivery",
            prompt: "Handle the payload.",
            trigger: { kind: "webhook" },
            timezone: "UTC",
          },
        ],
      }),
    );
    expect(template.routines).toEqual([
      {
        slug: "on-delivery",
        name: "On delivery",
        prompt: "Handle the payload.",
        timezone: "UTC",
        triggerKind: "webhook",
      },
    ]);
    const document = JSON.stringify(template);
    expect(document).not.toContain("key");
    expect(document).not.toContain("digest");
  });
});

describe("packages", () => {
  it("carries an installed Catalog Package by its Catalog identity", () => {
    const { template } = buildBotTemplateV1(
      source({
        packages: [
          {
            packageId: "mcp",
            version: "0.0.2",
            state: "installed",
            catalogId: "example-connector",
            catalogGeneration: "gen-7",
            provenance: "catalog",
            displayName: "Example connector",
          },
        ],
      }),
    );
    expect(template.packages).toEqual([
      {
        packageId: "mcp",
        catalogId: "example-connector",
        version: "0.0.2",
        displayName: "Example connector",
      },
    ]);
  });

  it("omits a first-party Package and counts it as built in", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        packages: [
          {
            packageId: "clock",
            version: "0.0.1",
            state: "installed",
            provenance: "first-party",
          },
          { packageId: "echo", version: "0.0.1", state: "installed" },
        ],
      }),
    );
    expect(template.packages).toEqual([]);
    expect(omitted(summary, "first-party-package")).toBe(2);
  });

  it("omits setup values entirely and records that it did", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        packages: [
          {
            packageId: "mcp",
            version: "0.0.1",
            state: "installed",
            catalogId: "example-connector",
            provenance: "catalog",
            values: { apiKey: "sk-live-do-not-share" },
          },
        ],
      }),
    );
    expect(JSON.stringify(template)).not.toContain("sk-live");
    expect(Object.keys(template.packages[0]!)).toEqual([
      "packageId",
      "catalogId",
      "version",
      "displayName",
    ]);
    expect(omitted(summary, "package-values")).toBe(1);
  });

  it("does not carry a Package that is disabled or failed", () => {
    const { template } = buildBotTemplateV1(
      source({
        packages: [
          {
            packageId: "mcp",
            version: "0.0.1",
            state: "disabled",
            catalogId: "example-connector",
            provenance: "catalog",
          },
        ],
      }),
    );
    expect(template.packages).toEqual([]);
  });
});

describe("MCP servers and Connections", () => {
  const publicServer = {
    packageId: "mcp",
    connectionTypeId: "mcp-remote",
    displayName: "Example",
    state: "ready",
    keyed: false,
    settings: { url: "https://mcp.example.test/mcp", transport: "sse" },
  } as const;

  const keyedServer = {
    packageId: "mcp",
    connectionTypeId: "mcp-remote-key",
    displayName: "Beeper",
    state: "ready",
    keyed: true,
    settings: { url: "https://beeper.example.test/mcp" },
  } as const;

  it("carries a public server as its url and transport", () => {
    const { template } = buildBotTemplateV1(
      source({ connections: [publicServer] }),
    );
    expect(template.mcpServers).toEqual([
      {
        kind: "public",
        name: "Example",
        url: "https://mcp.example.test/mcp",
        transport: "sse",
      },
    ]);
  });

  it("carries a keyed server as a placeholder with no url and no key", () => {
    const { template, summary } = buildBotTemplateV1(
      source({ connections: [keyedServer] }),
    );
    expect(template.mcpServers).toEqual([
      {
        kind: "needs-connection",
        name: "Beeper",
        connectionTypeId: "mcp-remote-key",
        hint: "This server needs your own Connection and credential.",
      },
    ]);
    expect(JSON.stringify(template)).not.toContain("beeper.example.test");
    expect(summary.needsConnection).toBe(1);
  });

  it("never carries a url for a private-network server", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        connections: [
          {
            packageId: "mcp",
            connectionTypeId: "mcp-remote",
            displayName: "Local",
            state: "ready",
            keyed: false,
            settings: { url: "https://10.1.2.3/mcp" },
          },
        ],
      }),
    );
    expect(template.mcpServers[0]).toMatchObject({ kind: "needs-connection" });
    expect(JSON.stringify(template)).not.toContain("10.1.2.3");
    expect(omitted(summary, "private-network-server")).toBe(1);
  });

  it("never carries a connectionId, safeMetadata, or model selection", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        connections: [publicServer, keyedServer],
        hasModelSelection: true,
      }),
    );
    const document = JSON.stringify(template);
    expect(document).not.toContain("connectionId");
    expect(document).not.toContain("safeMetadata");
    expect(omitted(summary, "connection")).toBe(2);
    expect(omitted(summary, "model")).toBe(1);
  });

  it("omits a Connection that names no server endpoint", () => {
    const { template, summary } = buildBotTemplateV1(
      source({
        connections: [
          {
            packageId: "provider-ollama-cloud",
            connectionTypeId: "ollama-cloud-account",
            displayName: "Work",
            state: "ready",
            keyed: true,
          },
        ],
      }),
    );
    expect(template.mcpServers).toEqual([]);
    expect(omitted(summary, "connection")).toBe(1);
  });

  it("skips a Connection that is not ready", () => {
    const { template } = buildBotTemplateV1(
      source({
        connections: [{ ...publicServer, state: "failed" }],
      }),
    );
    expect(template.mcpServers).toEqual([]);
  });
});

describe("profile avatar and Memory", () => {
  it("exports the Bot's sheep avatar", () => {
    const { template } = buildBotTemplateV1(source());
    expect(template.profile.avatar).toEqual({ kind: "sheep", recipe: sheep });
  });

  it("records that Memory is never exported", () => {
    const { template, summary } = buildBotTemplateV1(source());
    expect(Object.keys(template)).not.toContain("memory");
    expect(omitted(summary, "memory")).toBe(1);
  });
});

describe("helpers", () => {
  it("refuses a non-https or private server url", () => {
    expect(shareableServerUrlV1("https://mcp.example.test/mcp")).toBe(
      "https://mcp.example.test/mcp",
    );
    expect(shareableServerUrlV1("http://mcp.example.test/mcp")).toBeUndefined();
    expect(shareableServerUrlV1("https://localhost/mcp")).toBeUndefined();
    expect(shareableServerUrlV1("https://192.168.0.4/mcp")).toBeUndefined();
    expect(shareableServerUrlV1("https://[::1]/mcp")).toBeUndefined();
    expect(
      shareableServerUrlV1("https://a:b@mcp.example.test/"),
    ).toBeUndefined();
    expect(shareableServerUrlV1(42)).toBeUndefined();
  });

  it("falls back when a name slugifies to nothing", () => {
    expect(templateSlugV1("   ", "routine")).toBe("routine");
    expect(templateSlugV1("Morning Ledger!", "routine")).toBe("morning-ledger");
  });

  it("describes what was packed and what was scrubbed", () => {
    const { summary } = buildBotTemplateV1(
      source({
        skills: [
          {
            source: "bot",
            slug: "a",
            name: "A",
            body: "b",
            writer: { kind: "bot" },
          },
        ],
      }),
    );
    const description = describeTemplateSummaryV1(summary);
    expect(description).toContain("1 Skill");
    expect(description).toContain("Memory");
    expect(description).toContain("Nothing is shared until you choose");
  });
});
