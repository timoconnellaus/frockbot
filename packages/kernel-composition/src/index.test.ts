import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  type ActiveContribution,
  type ContributionHost,
  type ContributionKind,
  decodeFrockBotManifest,
  declaredContributionKinds,
  LocalCordisContributionHost,
  PackageCatalog,
  type PackageDescriptor,
  type PackageSettingSchema,
  type PreparedContribution,
} from "./index.js";

const roots: Context[] = [];

async function createCatalog(): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(PackageCatalog);
  return root;
}

function manifest(id = "fixture") {
  return {
    schemaVersion: 3,
    id,
    displayName: id,
    version: "1.0.0",
    compatibility: { frockbot: "*" },
    contributions: {
      runtime: { entry: "./agent" },
      desktop: {
        entry: "./host",
        execution: "trusted-main",
        commands: [],
      },
      client: { entry: "./client.ts", mounts: [], outlets: [] },
    },
    permissions: [],
  };
}

function v3ManifestWithSchema(schema: unknown) {
  return {
    schemaVersion: 3,
    id: "schema-fixture",
    displayName: "Schema Fixture",
    version: "1.0.0",
    compatibility: { frockbot: "*" },
    contributions: { runtime: { entry: "./runtime" } },
    configuration: {
      settings: [
        {
          id: "preferences",
          schemaVersion: 1,
          scopes: ["user"],
          schema,
        },
      ],
    },
  };
}

class FakeHost implements ContributionHost {
  readonly kind: ContributionKind;
  private log: string[];
  private failCommit: boolean;

  constructor(kind: ContributionKind, log: string[], failCommit = false) {
    this.kind = kind;
    this.log = log;
    this.failCommit = failCommit;
  }

  prepare(pkg: PackageDescriptor): Promise<PreparedContribution> {
    this.log.push(`prepare:${this.kind}:${pkg.manifest.id}`);
    return Promise.resolve({
      kind: this.kind,
      commit: async (): Promise<ActiveContribution> => {
        this.log.push(`commit:${this.kind}`);
        if (this.failCommit) throw new Error(`${this.kind} commit failed`);
        return {
          dispose: async () => {
            this.log.push(`dispose:${this.kind}`);
          },
        };
      },
      rollback: async () => {
        this.log.push(`rollback:${this.kind}`);
      },
    });
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("PackageCatalog", () => {
  test("keeps trusted main authority exclusive to manifest v3", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 1,
        id: "legacy-desktop",
        displayName: "Legacy Desktop",
        version: "1.0.0",
        contributions: { desktop: "./desktop" },
        permissions: [],
      }),
    ).toThrow("manifest v1 desktop Contributions are unsupported");
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 2,
        id: "v2-desktop",
        displayName: "V2 Desktop",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: {
          desktop: { entry: "./desktop", execution: "trusted-main" },
        },
        permissions: [],
      }),
    ).toThrow('manifest v2 desktop execution must be "sandboxed-renderer"');
  });

  // Constitution — Computer and Workspace: "durable roots, declared by the
  // Computer Package's Workspace layout **and by Package manifests**". This is
  // the manifest half; `image` and `applets` are its two callers today.
  test("decodes the durable roots a Package declares, and refuses a malformed one", () => {
    const base = {
      schemaVersion: 4 as const,
      id: "image",
      displayName: "Image generation",
      version: "1.0.0",
      compatibility: { frockbot: "*" },
      contributions: { runtime: { entry: "./agent" } },
      permissions: [],
    };
    expect(
      decodeFrockBotManifest({
        ...base,
        roots: [{ id: "generated", scope: "user" }],
      }).roots,
    ).toEqual([{ id: "generated", scope: "user" }]);
    // Absent stays absent: a Package that declares no root has none, and the
    // sync must not invent one.
    expect(decodeFrockBotManifest(base).roots).toBeUndefined();
    for (const [roots, message] of [
      [[], "non-empty bounded array"],
      [[{ id: "Generated", scope: "user" }], "id is invalid"],
      [[{ id: "-bad", scope: "user" }], "id is invalid"],
      // A `package-declared` root names no Bot, so a Bot-scoped one would be a
      // root `WorkspaceRootV1` cannot address.
      [[{ id: "generated", scope: "bot" }], 'scope must be "user"'],
      [[{ id: "generated" }], 'scope must be "user"'],
      [
        [
          { id: "generated", scope: "user" },
          { id: "generated", scope: "user" },
        ],
        "duplicate ids",
      ],
    ] as const) {
      expect(() => decodeFrockBotManifest({ ...base, roots })).toThrow(message);
    }
  });

  test("keeps a declared root out of reach of a v2 manifest", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 2,
        id: "legacy",
        displayName: "Legacy",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: { runtime: { entry: "./agent" } },
        permissions: [],
        roots: [{ id: "generated", scope: "user" }],
      }),
    ).toThrow('manifest has unknown field "roots"');
  });

  test("keeps backend Contributions unavailable to v2 manifests", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 2,
        id: "legacy",
        displayName: "Legacy",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: {
          backend: { entry: "./backend", host: "gateway" },
        },
        permissions: [],
      }),
    ).toThrow('manifest contributions has unknown field "backend"');
    expect(
      decodeFrockBotManifest({
        schemaVersion: 3,
        id: "current",
        displayName: "Current",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: {
          backend: { entry: "./backend", host: "bot" },
        },
        permissions: [],
      }).contributions.backend,
    ).toEqual([{ entry: "./backend", host: "bot" }]);
  });

  test("decodes the reference package manifest", async () => {
    const root = await createCatalog();
    const value = await Bun.file(
      new URL("../../plugin-clock/frockbot.json", import.meta.url),
    ).json();
    const installed = root.packages.install({
      specifier: "@frockbot/plugin-clock",
      manifest: value,
    });

    expect(installed.manifest).toMatchObject({
      schemaVersion: 3,
      id: "clock",
      contributions: {
        runtime: { entry: "./agent" },
      },
      permissions: ["time:read"],
    });
  });

  test("commits and disables contributions in dependency-safe order", async () => {
    const root = await createCatalog();
    const log: string[] = [];
    root.packages.registerHost(new FakeHost("runtime", log));
    root.packages.registerHost(new FakeHost("client", log));
    root.packages.registerHost(new FakeHost("desktop", log));
    root.packages.install({ specifier: "fixture", manifest: manifest() });

    await root.packages.enable("fixture");
    expect(root.packages.get("fixture")?.status).toBe("active");
    await root.packages.disable("fixture");

    expect(log).toEqual([
      "prepare:runtime:fixture",
      "prepare:client:fixture",
      "prepare:desktop:fixture",
      "commit:runtime",
      "commit:client",
      "commit:desktop",
      "dispose:desktop",
      "dispose:client",
      "dispose:runtime",
    ]);
    expect(root.packages.get("fixture")?.status).toBe("installed");
  });

  test("rolls back prepared and committed contributions after failure", async () => {
    const root = await createCatalog();
    const log: string[] = [];
    root.packages.registerHost(new FakeHost("runtime", log));
    root.packages.registerHost(new FakeHost("client", log));
    root.packages.registerHost(new FakeHost("desktop", log, true));
    root.packages.install({ specifier: "fixture", manifest: manifest() });

    let failure: unknown;
    try {
      await root.packages.enable("fixture");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain(
      "desktop commit failed",
    );
    expect(log.slice(-3)).toEqual([
      "dispose:client",
      "dispose:runtime",
      "rollback:desktop",
    ]);
    expect(root.packages.get("fixture")).toMatchObject({
      status: "failed",
      error: "desktop commit failed",
    });
  });

  test("mounts a local mobile contribution behind the host interface", async () => {
    const root = await createCatalog();
    let setups = 0;
    let cleanups = 0;
    const plugin = () => {
      setups += 1;
      return () => {
        cleanups += 1;
      };
    };
    root.packages.registerHost(
      new LocalCordisContributionHost("mobile", root, () =>
        Promise.resolve({ default: plugin }),
      ),
    );
    root.packages.install({
      specifier: "fixture",
      manifest: {
        schemaVersion: 1,
        id: "local-mobile",
        displayName: "Local Mobile",
        version: "1.0.0",
        contributions: { mobile: "./mobile" },
      },
    });

    await root.packages.enable("local-mobile");
    expect(setups).toBe(1);
    await root.packages.disable("local-mobile");
    expect(cleanups).toBe(1);
  });

  test("mounts a local Cordis contribution behind the host interface", async () => {
    const root = await createCatalog();
    let setups = 0;
    let cleanups = 0;
    const plugin = () => {
      setups += 1;
      return () => {
        cleanups += 1;
      };
    };
    root.packages.registerHost(
      new LocalCordisContributionHost("runtime", root, () =>
        Promise.resolve({ default: plugin }),
      ),
    );
    root.packages.install({
      specifier: "fixture",
      manifest: {
        schemaVersion: 1,
        id: "local",
        displayName: "Local",
        version: "1.0.0",
        contributions: { agent: "./agent" },
      },
    });

    await root.packages.enable("local");
    expect(setups).toBe(1);
    await root.packages.disable("local");
    expect(cleanups).toBe(1);
  });
});

describe("decodeFrockBotManifest", () => {
  test("accepts iframe UI only in settings or its own declared tool-result slots", () => {
    const manifest = {
      schemaVersion: 3,
      id: "weather-page",
      displayName: "Weather page",
      version: "0.0.1",
      compatibility: { frockbot: ">=0.0.1" },
      dependencies: {},
      contributions: {
        runtime: { entry: "./package.js", host: "bot-isolate" },
        client: {
          kind: "iframe",
          artifact: {
            contentHash: "a".repeat(64),
            size: 123,
            mediaType: "text/html",
            bundlerVersion: "frockbot-inline-html@1",
          },
          mounts: [
            { slot: "frockbot.tool-result:weather_lookup" },
            { slot: "frockbot.bot-settings-sections", order: 10 },
          ],
        },
      },
      tools: [
        { name: "weather_lookup", description: "Weather", inputSchema: {} },
      ],
      hooks: ["agent/tool-exposure"],
      permissions: [],
    };
    const decoded = decodeFrockBotManifest(manifest);
    const client = decoded.contributions.client;
    expect(client && "kind" in client ? client.kind : undefined).toBe("iframe");
    expect(client?.mounts[0]).toEqual({
      slot: "frockbot.tool-result:weather_lookup",
    });
    expect(decoded.hooks).toEqual(["agent/tool-exposure"]);
    expect(() =>
      decodeFrockBotManifest({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          client: {
            ...manifest.contributions.client,
            mounts: [{ slot: "root" }],
          },
        },
      }),
    ).toThrow("not iframe-safe");
    expect(() =>
      decodeFrockBotManifest({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          client: {
            ...manifest.contributions.client,
            mounts: [{ slot: "frockbot.tool-result:package_author" }],
          },
        },
      }),
    ).toThrow("undeclared tool");
    expect(() =>
      decodeFrockBotManifest({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          client: {
            ...manifest.contributions.client,
            artifact: {
              ...manifest.contributions.client.artifact,
              size: 256 * 1024 + 1,
            },
          },
        },
      }),
    ).toThrow("256 KB quota");
  });

  test("keeps trusted Electron main execution exclusive to manifest v3", () => {
    const contribution = {
      desktop: {
        entry: "./desktop",
        execution: "trusted-main",
        commands: [],
      },
    };
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 2,
        id: "desktop-v2",
        displayName: "Desktop v2",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: contribution,
        permissions: [],
      }),
    ).toThrow('manifest v2 desktop execution must be "sandboxed-renderer"');
    expect(
      decodeFrockBotManifest({
        schemaVersion: 3,
        id: "desktop-v3",
        displayName: "Desktop v3",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: contribution,
        permissions: [],
      }).contributions.desktop,
    ).toEqual({
      entry: "./desktop",
      execution: "trusted-main",
      commands: [],
    });
  });

  test("decodes an explicitly hosted backend Contribution", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "connection-driver",
      displayName: "Connection driver",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: {
        backend: { entry: "./backend", host: "gateway" },
      },
      permissions: [],
      configuration: {},
    });
    expect(decoded.contributions.backend).toEqual([
      { entry: "./backend", host: "gateway" },
    ]);
    expect(declaredContributionKinds(decoded)).toEqual(["backend"]);
  });

  test("accepts a manifest that only contributes to mobile", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 1,
      id: "mobile-only",
      displayName: "Mobile Only",
      version: "1.0.0",
      contributions: { mobile: "./mobile" },
      permissions: ["mobile:notifications"],
    });

    expect(decoded.contributions).toEqual({
      runtime: undefined,
      client: undefined,
      desktop: undefined,
      mobile: { entry: "./mobile" },
    });
    expect(declaredContributionKinds(decoded)).toEqual(["mobile"]);
  });

  test("rejects a mobile contribution that is not a relative export path", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 1,
        id: "mobile-only",
        displayName: "Mobile Only",
        version: "1.0.0",
        contributions: { mobile: "mobile" },
      }),
    ).toThrow('manifest contribution "mobile" must be a relative export path');
  });

  test("decodes manifest v3 settings, Connection Types, and capabilities", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "composio",
      displayName: "Composio",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: { runtime: { entry: "./runtime" } },
      permissions: ["connections:manage"],
      configuration: {
        settings: [
          {
            id: "preferences",
            schemaVersion: 1,
            scopes: ["user"],
            schema: { type: "object", properties: {} },
          },
        ],
        connectionTypes: [
          {
            id: "gmail",
            displayName: "Gmail",
            allowMultiple: true,
            authorization: { kind: "grant", driverId: "composio" },
            capabilities: ["gmail-tools"],
          },
        ],
        capabilities: [
          {
            id: "gmail-tools",
            kind: "tool",
            connectionTypes: ["gmail"],
          },
        ],
      },
    });

    expect(decoded).toMatchObject({
      schemaVersion: 3,
      configuration: {
        connectionTypes: [{ id: "gmail", authorization: { kind: "grant" } }],
        capabilities: [{ id: "gmail-tools", kind: "tool" }],
      },
    });
  });

  test("decodes the exact provider-neutral model setting role", () => {
    const decoded = decodeFrockBotManifest({
      ...manifest("custom-models"),
      configuration: {
        settings: [
          {
            id: "model",
            schemaVersion: 1,
            scopes: ["user", "bot"],
            role: "model",
            schema: {
              type: "object",
              properties: {
                connectionId: { type: "string" },
                providerModelId: { type: "string" },
              },
              required: ["connectionId", "providerModelId"],
              additionalProperties: false,
            },
          },
        ],
      },
    });

    expect(decoded.configuration?.settings).toEqual([
      {
        id: "model",
        schemaVersion: 1,
        scopes: ["user", "bot"],
        role: "model",
        schema: {
          type: "object",
          properties: {
            connectionId: { type: "string" },
            providerModelId: { type: "string" },
          },
          required: ["connectionId", "providerModelId"],
          additionalProperties: false,
        },
      },
    ]);
  });

  test("rejects any other schema for a model-role setting", () => {
    const exact = {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        providerModelId: { type: "string" },
      },
      required: ["connectionId", "providerModelId"],
      additionalProperties: false,
    };
    for (const schema of [
      { ...exact, additionalProperties: true },
      { ...exact, required: ["connectionId"] },
      {
        ...exact,
        properties: {
          ...exact.properties,
          providerModelId: { type: "number" },
        },
      },
      { ...exact, title: "Choose a model" },
    ]) {
      expect(() =>
        decodeFrockBotManifest({
          ...manifest("custom-models"),
          configuration: {
            settings: [
              {
                id: "model",
                schemaVersion: 1,
                scopes: ["user"],
                role: "model",
                schema,
              },
            ],
          },
        }),
      ).toThrow(/model setting schema must be exactly/);
    }
  });

  test("decodes an ambient-native Connection without an authorization driver", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 4,
      id: "flock-ai",
      displayName: "Flock AI",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: { runtime: { entry: "./runtime" } },
      permissions: ["models:invoke"],
      configuration: {
        connectionTypes: [
          {
            id: "flock-ai-account",
            displayName: "Flock AI",
            allowMultiple: false,
            authorization: { kind: "ambient-native" },
            capabilities: ["flock-ai-models"],
          },
        ],
        capabilities: [
          {
            id: "flock-ai-models",
            kind: "model",
            connectionTypes: ["flock-ai-account"],
          },
        ],
      },
    });

    expect(decoded.configuration?.connectionTypes[0]?.authorization).toEqual({
      kind: "ambient-native",
    });
  });

  test("decodes a manifest v4 Capability admission ceiling", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 4,
      id: "shell",
      displayName: "Shell",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: { runtime: { entry: "./runtime" } },
      permissions: [],
      configuration: {
        capabilities: [
          {
            id: "user-voice",
            kind: "tool",
            connectionTypes: [],
            admission: { turnTypes: ["chat"] },
          },
          { id: "work", kind: "tool", connectionTypes: [] },
        ],
      },
    });

    expect(decoded).toMatchObject({
      schemaVersion: 4,
      configuration: {
        capabilities: [
          { id: "user-voice", admission: { turnTypes: ["chat"] } },
          { id: "work" },
        ],
      },
    });
    expect(decoded.configuration?.capabilities[1]?.admission).toBeUndefined();
  });

  test("rejects an unknown turn type in a v4 admission ceiling", () => {
    const manifestWith = (admission: unknown) => ({
      schemaVersion: 4,
      id: "shell",
      displayName: "Shell",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: { runtime: { entry: "./runtime" } },
      permissions: [],
      configuration: {
        capabilities: [
          { id: "user-voice", kind: "tool", connectionTypes: [], admission },
        ],
      },
    });
    expect(() =>
      decodeFrockBotManifest(manifestWith({ turnTypes: ["routine"] })),
    ).toThrow(/turn type is invalid/);
    expect(() =>
      decodeFrockBotManifest(manifestWith({ turnTypes: [] })),
    ).toThrow(/admission turnTypes must not be empty/);
    expect(() =>
      decodeFrockBotManifest(manifestWith({ turnTypes: ["chat"], extra: 1 })),
    ).toThrow(/unknown field/);
  });

  test("keeps the admission ceiling exclusive to manifest v4", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 3,
        id: "shell",
        displayName: "Shell",
        version: "1.0.0",
        compatibility: { frockbot: ">=0.0.1" },
        contributions: { runtime: { entry: "./runtime" } },
        permissions: [],
        configuration: {
          capabilities: [
            {
              id: "user-voice",
              kind: "tool",
              connectionTypes: [],
              admission: { turnTypes: ["chat"] },
            },
          ],
        },
      }),
    ).toThrow(/unknown field "admission"/);
  });

  test("decodes a v4 manifest exactly as v3 apart from the admission field", () => {
    const body = {
      id: "composio",
      displayName: "Composio",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: {
        backend: { entry: "./backend", host: "gateway" },
        desktop: {
          entry: "./desktop",
          execution: "trusted-main",
          commands: [],
        },
      },
      permissions: ["connections:manage"],
      configuration: {
        capabilities: [{ id: "gmail-tools", kind: "tool" }],
      },
    };
    const v3 = decodeFrockBotManifest({ ...body, schemaVersion: 3 });
    const v4 = decodeFrockBotManifest({ ...body, schemaVersion: 4 });
    expect({ ...v4, schemaVersion: 3 }).toEqual(v3);
  });

  test("v4 still decodes exactly as it did", () => {
    expect(
      decodeFrockBotManifest({
        schemaVersion: 4,
        id: "routines",
        displayName: "Routines",
        version: "0.0.1",
        compatibility: { frockbot: "*" },
        dependencies: {},
        contributions: { runtime: { entry: "./agent" } },
        permissions: [],
        configuration: {
          settings: [],
          connectionTypes: [],
          capabilities: [
            {
              id: "routine-tools",
              kind: "tool",
              connectionTypes: [],
              admission: { turnTypes: ["chat", "subagent"] },
            },
          ],
        },
      }),
    ).toMatchObject({ schemaVersion: 4 });
  });

  test("rejects an unsupported manifest version", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 5,
        id: "future",
        displayName: "Future",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: { runtime: { entry: "./runtime" } },
        permissions: [],
      }),
    ).toThrow(/unsupported FrockBot manifest version/);
  });

  test("rejects unknown fields at every manifest object boundary", () => {
    const cases: Array<[string, unknown]> = [
      ["", { ...manifest(), unexpected: true }],
      [
        "compatibility",
        { ...manifest(), compatibility: { frockbot: "*", unexpected: true } },
      ],
      [
        "contributions",
        {
          ...manifest(),
          contributions: {
            ...manifest().contributions,
            unexpected: { entry: "./unexpected" },
          },
        },
      ],
      [
        "runtime contribution",
        {
          ...manifest(),
          contributions: {
            runtime: { entry: "./agent", unexpected: true },
          },
        },
      ],
      [
        "backend contribution",
        {
          ...manifest(),
          contributions: {
            backend: {
              entry: "./backend",
              host: "bot",
              unexpected: true,
            },
          },
        },
      ],
      [
        "client contribution",
        {
          ...manifest(),
          contributions: {
            client: { entry: "./client", mounts: [], unexpected: true },
          },
        },
      ],
      [
        "client mount",
        {
          ...manifest(),
          contributions: {
            client: {
              entry: "./client",
              mounts: [{ slot: "root", unexpected: true }],
            },
          },
        },
      ],
      [
        "desktop contribution",
        {
          ...manifest(),
          contributions: {
            desktop: {
              entry: "./desktop",
              execution: "trusted-main",
              unexpected: true,
            },
          },
        },
      ],
      [
        "mobile contribution",
        {
          ...manifest(),
          contributions: {
            mobile: { entry: "./mobile", unexpected: true },
          },
        },
      ],
      [
        "configuration",
        {
          ...manifest(),
          configuration: { unexpected: true },
        },
      ],
      [
        "setting definition",
        {
          ...v3ManifestWithSchema({ type: "string" }),
          configuration: {
            settings: [
              {
                id: "preferences",
                schemaVersion: 1,
                scopes: ["user"],
                schema: { type: "string" },
                unexpected: true,
              },
            ],
          },
        },
      ],
      [
        "connection definition",
        {
          ...manifest(),
          configuration: {
            connectionTypes: [
              {
                id: "mail",
                displayName: "Mail",
                allowMultiple: false,
                authorization: { kind: "grant", driverId: "driver" },
                unexpected: true,
              },
            ],
          },
        },
      ],
      [
        "connection authorization",
        {
          ...manifest(),
          configuration: {
            connectionTypes: [
              {
                id: "mail",
                displayName: "Mail",
                allowMultiple: false,
                authorization: {
                  kind: "grant",
                  driverId: "driver",
                  unexpected: true,
                },
              },
            ],
          },
        },
      ],
      [
        "capability definition",
        {
          ...manifest(),
          configuration: {
            capabilities: [
              { id: "mail-tools", kind: "tool", unexpected: true },
            ],
          },
        },
      ],
      [
        "legacy web contribution",
        {
          schemaVersion: 1,
          id: "legacy",
          displayName: "Legacy",
          version: "1.0.0",
          contributions: {
            web: { entry: "./web", slots: [], unexpected: true },
          },
        },
      ],
    ];

    for (const [boundary, candidate] of cases) {
      expect(() => decodeFrockBotManifest(candidate)).toThrow(
        `${boundary ? `manifest ${boundary}` : "manifest"} has unknown field "unexpected"`,
      );
    }
  });

  test("rejects non-enumerable and symbol fields", () => {
    const nonEnumerableCompatibility = { frockbot: "*" };
    Object.defineProperty(nonEnumerableCompatibility, "hidden", {
      value: true,
    });
    const symbolCompatibility = { frockbot: "*" };
    Object.defineProperty(symbolCompatibility, Symbol("unexpected"), {
      value: true,
    });

    for (const [field, compatibility] of [
      ["hidden", nonEnumerableCompatibility],
      ["Symbol(unexpected)", symbolCompatibility],
    ] as const) {
      expect(() =>
        decodeFrockBotManifest({ ...manifest(), compatibility }),
      ).toThrow(`manifest compatibility has unknown field "${field}"`);
    }
  });

  test("recursively decodes the supported manifest v3 schema subset", () => {
    const schema = {
      type: "object",
      title: "Preferences",
      description: "Bounded provider preferences",
      properties: {
        endpoint: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          enum: ["primary", "secondary"],
        },
        retries: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          multipleOf: 1,
        },
        flags: {
          type: "array",
          items: { type: "boolean", const: true },
          minItems: 0,
          maxItems: 3,
          uniqueItems: true,
        },
      },
      required: ["endpoint"],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 3,
    } satisfies PackageSettingSchema;

    const decoded = decodeFrockBotManifest(v3ManifestWithSchema(schema));

    expect(decoded.configuration?.settings[0]?.schema).toEqual(schema);
    expect(decoded.configuration?.settings[0]?.schema).not.toBe(schema);
    expect(
      decoded.configuration?.settings[0]?.schema.properties?.flags,
    ).not.toBe(schema.properties.flags);
  });

  test("rejects references, defaults, formats, and unknown schema keywords", () => {
    const forbidden = [
      "$schema",
      "$id",
      "$anchor",
      "$dynamicAnchor",
      "$ref",
      "$dynamicRef",
      "$defs",
      "definitions",
      "default",
      "format",
      "pattern",
      "contentEncoding",
      "contentMediaType",
      "contentSchema",
      "examples",
      "deprecated",
      "readOnly",
      "writeOnly",
      "allOf",
      "anyOf",
      "oneOf",
      "not",
      "if",
      "then",
      "else",
      "prefixItems",
      "contains",
      "patternProperties",
      "propertyNames",
      "dependentRequired",
      "dependentSchemas",
      "unevaluatedProperties",
      "minContains",
      "maxContains",
      "unevaluatedItems",
      "unknownKeyword",
    ];

    for (const keyword of forbidden) {
      expect(() =>
        decodeFrockBotManifest(
          v3ManifestWithSchema({ type: "string", [keyword]: "forbidden" }),
        ),
      ).toThrow(`manifest setting schema "${keyword}" is not supported`);
    }

    expect(() =>
      decodeFrockBotManifest(
        v3ManifestWithSchema({
          type: "object",
          properties: {
            nested: { type: "string", default: "secret" },
          },
        }),
      ),
    ).toThrow('manifest setting schema "default" is not supported');
    expect(() =>
      decodeFrockBotManifest(
        v3ManifestWithSchema({
          type: "array",
          items: { type: "string", format: "password" },
        }),
      ),
    ).toThrow('manifest setting schema "format" is not supported');
  });

  test("rejects malformed supported schema keyword values", () => {
    const malformed = [
      null,
      [],
      "schema",
      { type: ["string"] },
      { type: "string", title: 1 },
      { type: "string", description: false },
      { type: "string", enum: [] },
      { type: "string", enum: ["duplicate", "duplicate"] },
      { type: "string", enum: [1] },
      { type: "string", const: {} },
      { type: "string", const: 1 },
      { type: "object", properties: [] },
      { type: "object", properties: { nested: "invalid" } },
      { type: "object", properties: { "": { type: "string" } } },
      { type: "object", properties: {}, required: "name" },
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name", "name"],
      },
      { type: "object", properties: {}, required: ["missing"] },
      { type: "object", additionalProperties: {} },
      { type: "array", items: [] },
      { type: "string", minLength: -1 },
      { type: "string", maxLength: 1.5 },
      { type: "number", minimum: Number.NaN },
      { type: "number", maximum: "five" },
      { type: "number", multipleOf: 0 },
      { type: "array", minItems: -1 },
      { type: "array", maxItems: 1.5 },
      { type: "array", uniqueItems: "yes" },
      { type: "object", minProperties: -1 },
      { type: "object", maxProperties: 1.5 },
      { type: "string", minLength: 2, maxLength: 1 },
      { type: "array", minItems: 2, maxItems: 1 },
      { type: "object", minProperties: 2, maxProperties: 1 },
      { type: "number", minimum: 2, maximum: 1 },
      { type: "string", minimum: 0 },
      { type: "array", minLength: 0 },
      { type: "object", minItems: 0 },
      { type: "boolean", properties: {} },
    ];

    for (const schema of malformed) {
      expect(() =>
        decodeFrockBotManifest(v3ManifestWithSchema(schema)),
      ).toThrow();
    }
  });

  test("rejects non-JSON and structurally ambiguous schema values", () => {
    const sparseEnum = new Array(1);
    const sparseRequired = new Array(1);
    const arrayWithExtraEntry = ["value"] as unknown[] & { extra?: string };
    arrayWithExtraEntry.extra = "hidden";
    const arrayWithOutOfRangeEntry = ["value"] as unknown[] & {
      [key: string]: unknown;
    };
    Object.defineProperty(arrayWithOutOfRangeEntry, "4294967295", {
      enumerable: true,
      value: undefined,
    });
    const inherited = Object.assign(Object.create({ default: "secret" }), {
      type: "string",
    });
    const inheritedProperties = Object.assign(
      Object.create({ hidden: { type: "string" } }),
      { visible: { type: "string" } },
    );
    const symbolKey = { type: "string" } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("hidden")] = "value";
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get: () => "string",
    });
    const cyclic: Record<string, unknown> = { type: "array" };
    cyclic.items = cyclic;

    const invalidSchemas = [
      { type: undefined },
      { type: "string", title: undefined },
      { type: "string", description: Symbol("description") },
      { type: () => "string" },
      { type: "string", enum: sparseEnum },
      { type: "string", enum: [undefined] },
      { type: "number", enum: [Number.POSITIVE_INFINITY] },
      { type: "integer", enum: [1n] },
      { type: "object", properties: { value: undefined } },
      { type: "object", properties: inheritedProperties },
      { type: "object", properties: {}, required: sparseRequired },
      { type: "object", properties: {}, required: [undefined] },
      { type: "array", items: undefined },
      { type: "string", enum: arrayWithExtraEntry },
      { type: "string", enum: arrayWithOutOfRangeEntry },
      inherited,
      symbolKey,
      accessor,
      cyclic,
      new Date(),
    ];

    for (const schema of invalidSchemas) {
      expect(() =>
        decodeFrockBotManifest(v3ManifestWithSchema(schema)),
      ).toThrow();
    }
  });

  test("rejects excessively deep and large manifest v3 schemas", () => {
    let deeplyNested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 13; depth += 1) {
      deeplyNested = { type: "array", items: deeplyNested };
    }
    expect(() =>
      decodeFrockBotManifest(v3ManifestWithSchema(deeplyNested)),
    ).toThrow("manifest setting schema is too deeply nested");
    expect(() =>
      decodeFrockBotManifest(
        v3ManifestWithSchema({
          type: "string",
          description: "x".repeat(50_000),
        }),
      ),
    ).toThrow("manifest setting schema is too large");
  });

  test("decodes the exact Bot isolate runtime and tool declaration", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "authored",
      displayName: "Authored",
      version: "0.0.1",
      compatibility: { frockbot: ">=0.0.1" },
      dependencies: {},
      contributions: {
        runtime: { entry: "./package.js", host: "bot-isolate" },
      },
      tools: [
        {
          name: "look_up",
          description: "Looks up a value",
          inputSchema: { type: "object" },
        },
      ],
      hooks: ["agent/tool-exposure", "tools/post-execute"],
      permissions: [],
    });

    expect(decoded.contributions.runtime?.host).toBe("bot-isolate");
    expect(decoded.tools?.map((tool) => tool.name)).toEqual(["look_up"]);
    expect(decoded.hooks).toEqual([
      "agent/tool-exposure",
      "tools/post-execute",
    ]);
  });

  test("requires Bot isolate runtime and tools declarations together", () => {
    const base = {
      schemaVersion: 3,
      id: "authored",
      displayName: "Authored",
      version: "0.0.1",
      compatibility: { frockbot: ">=0.0.1" },
      dependencies: {},
      permissions: [],
    };
    expect(() =>
      decodeFrockBotManifest({
        ...base,
        contributions: {
          runtime: { entry: "./package.js", host: "bot-isolate" },
        },
      }),
    ).toThrow(/must appear together/);
    expect(() =>
      decodeFrockBotManifest({
        ...base,
        contributions: { runtime: { entry: "./package.js" } },
        hooks: ["agent/tool-exposure"],
      }),
    ).toThrow(/hooks require a bot-isolate/);
    expect(() =>
      decodeFrockBotManifest({
        ...base,
        contributions: { runtime: { entry: "./package.js" } },
        tools: [{ name: "look_up", description: "Looks", inputSchema: {} }],
      }),
    ).toThrow(/must appear together/);
  });

  test("orders normalized contribution kinds", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "every-kind",
      displayName: "Every Kind",
      version: "1.0.0",
      compatibility: { frockbot: "*" },
      contributions: {
        client: { entry: "./client.ts", mounts: [], outlets: [] },
        mobile: { entry: "./mobile" },
        desktop: {
          entry: "./host",
          execution: "trusted-main",
          commands: [],
        },
        runtime: { entry: "./agent" },
      },
    });

    expect(declaredContributionKinds(decoded)).toEqual([
      "runtime",
      "client",
      "desktop",
      "mobile",
    ]);
  });
});
