import { describe, expect, test } from "bun:test";
import { ISOLATE_CONTRACT_VERSION } from "./isolate.js";
import {
  decodePluginDescriptorV1,
  PLUGIN_SLOTS_V1,
  pluginCardToolNameV1,
  pluginNetworkAdmitsHostV1,
  servedPluginContractVersionsV1,
} from "./plugin-descriptor.js";
import { ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 } from "./skills.js";

const base = {
  id: "weather",
  displayName: "Weather",
  version: "1.0.0",
  contractVersion: 3,
  tools: [],
  hooks: [],
  grants: [],
  contextKeys: ["user", "bot", "session"],
};

describe("a plugin's declared views", () => {
  test("names a slot from the vocabulary and a surface the wire accepts", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "settings.sections", surfaceId: "weather.defaults" },
          { slot: "conversation.panel", surfaceId: "weather.board" },
          {
            slot: "bot.nav",
            surfaceId: "weather.door",
            label: "Forecast",
            opens: "weather.board",
          },
        ],
      }).views,
    ).toEqual([
      { slot: "settings.sections", surfaceId: "weather.defaults" },
      { slot: "conversation.panel", surfaceId: "weather.board" },
      {
        slot: "bot.nav",
        surfaceId: "weather.door",
        label: "Forecast",
        opens: "weather.board",
      },
    ]);
    // Absent stays absent: a plugin that renders nothing declares nothing.
    expect(decodePluginDescriptorV1(base).views).toBeUndefined();
  });

  test("refuses a slot the vocabulary does not name", () => {
    expect(PLUGIN_SLOTS_V1).not.toContain("trust.chrome");
    expect(PLUGIN_SLOTS_V1).not.toContain("sidebar.entries");
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [{ slot: "trust.chrome", surfaceId: "weather" }],
      }),
    ).toThrow();
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [{ slot: "sidebar.entries", surfaceId: "weather" }],
      }),
    ).toThrow();
  });

  test("refuses a surface id the client wire would not carry", () => {
    for (const surfaceId of [
      "",
      ".hidden",
      "weather forecast",
      "a".repeat(129),
    ])
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          views: [{ slot: "conversation.panel", surfaceId }],
        }),
      ).toThrow();
  });

  test("refuses two views on one surface, an unbounded list and extra fields", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "conversation.panel", surfaceId: "weather" },
          { slot: "bot.profile", surfaceId: "weather" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: Array.from({ length: 17 }, (_, index) => ({
          slot: "conversation.panel",
          surfaceId: `weather-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          {
            slot: "conversation.panel",
            surfaceId: "weather",
            botId: "default",
          },
        ],
      }),
    ).toThrow();
  });

  test("a second panel view needs a label; opens only names this plugin's panel", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "conversation.panel", surfaceId: "inbox" },
          { slot: "conversation.panel", surfaceId: "board" },
        ],
      }),
    ).toThrow(/label/);
    expect(
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "conversation.panel", surfaceId: "inbox", label: "Inbox" },
          { slot: "conversation.panel", surfaceId: "board", label: "Board" },
        ],
      }).views,
    ).toHaveLength(2);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          {
            slot: "conversation.panel",
            surfaceId: "inbox",
            opens: "inbox",
          },
        ],
      }),
    ).toThrow(/only valid on bot.nav/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          {
            slot: "bot.nav",
            surfaceId: "door",
            opens: "missing",
          },
        ],
      }),
    ).toThrow(/conversation.panel/);
  });
});

describe("a panel view that names a page", () => {
  test("keeps the page on a conversation.panel view", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        views: [
          {
            slot: "conversation.panel",
            surfaceId: "tuner",
            label: "Tuner",
            page: "tuner.html",
          },
          {
            slot: "conversation.panel",
            surfaceId: "board",
            label: "Board",
            page: "pages/board.html",
          },
        ],
      }).views?.map((view) => view.page),
    ).toEqual(["tuner.html", "pages/board.html"]);
  });

  test("refuses a page anywhere but the conversation panel", () => {
    for (const slot of ["settings.sections", "bot.nav"]) {
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          views: [{ slot, surfaceId: "tuner", page: "tuner.html" }],
        }),
      ).toThrow(/only valid on conversation.panel/);
    }
  });

  test("refuses a page path outside the plugin's source or not HTML", () => {
    for (const page of [
      "../tuner.html",
      "/tuner.html",
      "tuner.js",
      "a/b/tuner.html",
      "Tuner.html",
      "https://example.com/tuner.html",
    ]) {
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          views: [{ slot: "conversation.panel", surfaceId: "tuner", page }],
        }),
      ).toThrow(/\.html file/);
    }
  });
});

describe("the device grant", () => {
  const PAGE_VIEW = {
    slot: "conversation.panel",
    surfaceId: "tuner",
    page: "tuner.html",
  };

  test("names the abilities the host may open for the Plugin's page", () => {
    const decoded = decodePluginDescriptorV1({
      ...base,
      grants: ["device"],
      device: { abilities: ["microphone"] },
      views: [PAGE_VIEW],
    });
    expect(decoded.grants).toEqual(["device"]);
    expect(decoded.device).toEqual({ abilities: ["microphone"] });
  });

  test("is present exactly when granted, and names only what a client opens", () => {
    for (const shape of [
      { grants: ["device"] },
      { grants: [], device: { abilities: ["microphone"] } },
      { grants: ["device"], device: { abilities: [] } },
      { grants: ["device"], device: { abilities: ["camera"] } },
      { grants: ["device"], device: { abilities: ["shell"] } },
      { grants: ["device"], device: { abilities: ["microphone"], extra: 1 } },
    ]) {
      expect(() =>
        decodePluginDescriptorV1({ ...base, ...shape, views: [PAGE_VIEW] }),
      ).toThrow();
    }
  });

  test("needs a page to open an ability for", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        grants: ["device"],
        device: { abilities: ["microphone"] },
        views: [{ slot: "conversation.panel", surfaceId: "tuner" }],
      }),
    ).toThrow(/names a page/);
  });
});

describe("a device module", () => {
  const bridge = {
    id: "bridge",
    platforms: ["macos"],
    read: ["~/Library/Messages/chat.db"],
    net: ["localhost:23373"],
    appleEvents: ["com.apple.iChat"],
    calls: ["search", "send"],
    events: ["message"],
  };
  const withModule = (module: Record<string, unknown>) => ({
    ...base,
    grants: ["device"],
    device: { abilities: [], modules: [module] },
    triggers: [{ name: "message", description: "A new message arrived." }],
  });

  test("names what its process may reach, and needs no page", () => {
    expect(
      decodePluginDescriptorV1(withModule(bridge)).device as unknown,
    ).toEqual({
      abilities: [],
      modules: [bridge],
    });
  });

  test("refuses a reach it cannot confine", () => {
    for (const change of [
      { read: ["relative/path"] },
      { read: ["~/../etc/passwd"] },
      { read: ["/Users/tim/../root"] },
      { read: ["/a//b"] },
      { net: ["example.com:443"] },
      { net: ["localhost:0"] },
      { net: ["localhost:70000"] },
      { appleEvents: ["iChat"] },
      { platforms: [] },
      { platforms: ["ios"] },
      { calls: ["Search"] },
      { id: "Bridge" },
      { extra: true },
    ]) {
      expect(() =>
        decodePluginDescriptorV1(withModule({ ...bridge, ...change })),
      ).toThrow();
    }
  });

  test("emits only the Plugin's own triggers", () => {
    expect(() =>
      decodePluginDescriptorV1(withModule({ ...bridge, events: ["other"] })),
    ).toThrow(/not one of the Plugin's triggers/);
  });

  test("a device grant names an ability or a module", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        grants: ["device"],
        device: { abilities: [], modules: [] },
      }),
    ).toThrow(/no ability and no module/);
  });
});

describe("a plugin's hooks and contract", () => {
  test("orders hooks by the vocabulary and refuses an unopened event", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        hooks: [
          "tools/post-execute",
          "agent/request",
          "system-prompt/assemble",
        ],
      }).hooks,
    ).toEqual([
      "system-prompt/assemble",
      "agent/request",
      "tools/post-execute",
    ]);
    expect(() =>
      decodePluginDescriptorV1({ ...base, hooks: ["agent/request-error"] }),
    ).toThrow(/hooks\[0\]/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        hooks: ["agent/request", "agent/request"],
      }),
    ).toThrow(/duplicates/);
  });

  test("names a contract this deployment knows; the served pair is current and previous", () => {
    expect(
      decodePluginDescriptorV1({ ...base, contractVersion: 2 }).contractVersion,
    ).toBe(2);
    expect(() =>
      decodePluginDescriptorV1({ ...base, contractVersion: 0 }),
    ).toThrow(/contractVersion/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        contractVersion: ISOLATE_CONTRACT_VERSION + 1,
      }),
    ).toThrow(/contractVersion/);
    expect(servedPluginContractVersionsV1()).toEqual<number[]>([
      ISOLATE_CONTRACT_VERSION - 1,
      ISOLATE_CONTRACT_VERSION,
    ]);
  });
});

describe("a plugin's network", () => {
  test("is present exactly when the http grant is", () => {
    expect(() =>
      decodePluginDescriptorV1({ ...base, network: { open: true } }),
    ).toThrow(/http grant/);
    expect(() =>
      decodePluginDescriptorV1({ ...base, grants: ["http"] }),
    ).toThrow(/http grant/);
    expect(
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { hosts: ["api.example.com", "*.weather.example"] },
      }).network,
    ).toEqual({ hosts: ["*.weather.example", "api.example.com"] });
    expect(
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { open: true },
      }).network,
    ).toEqual({ open: true });
  });

  test("refuses anything that is not a lowercase hostname", () => {
    for (const host of [
      "https://api.example.com",
      "API.example.com",
      "example",
      "*.com",
      "a.*.example.com",
      "",
    ]) {
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          grants: ["http"],
          network: { hosts: [host] },
        }),
      ).toThrow();
    }
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { open: false },
      }),
    ).toThrow(/open/);
  });

  test("a wildcard admits subdomains and never the bare domain", () => {
    const network = { hosts: ["*.example.com", "api.other.test"] };
    expect(pluginNetworkAdmitsHostV1(network, "api.example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "a.b.example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "API.Example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "example.com")).toBe(false);
    expect(pluginNetworkAdmitsHostV1(network, "notexample.com")).toBe(false);
    expect(pluginNetworkAdmitsHostV1(network, "api.other.test")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "x.api.other.test")).toBe(false);
    // The `http` grant with no outbound network: a Plugin that opens a kernel
    // loopback and nothing else. It admits no host at all.
    expect(pluginNetworkAdmitsHostV1({ hosts: [] }, "api.example.com")).toBe(
      false,
    );
    expect(pluginNetworkAdmitsHostV1({ open: true }, "anything.invalid")).toBe(
      true,
    );
  });
});

describe("a plugin's services, triggers and settings", () => {
  test("provides and consumes are typed by name and major version", () => {
    const descriptor = decodePluginDescriptorV1({
      ...base,
      provides: [{ name: "weather-data", version: 2 }],
      consumes: [{ name: "geocoder", version: 1 }],
    });
    expect(descriptor.provides).toEqual([{ name: "weather-data", version: 2 }]);
    expect(descriptor.consumes).toEqual([{ name: "geocoder", version: 1 }]);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [{ name: "x", version: 1 }],
        consumes: [{ name: "x", version: 1 }],
      }),
    ).toThrow(/also consumes/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [{ name: "x", version: 0 }],
      }),
    ).toThrow(/version/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [
          { name: "x", version: 1 },
          { name: "x", version: 2 },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test("triggers are named and described, and unique", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        triggers: [
          { name: "forecast_ready", description: "A forecast landed" },
        ],
      }).triggers,
    ).toEqual([{ name: "forecast_ready", description: "A forecast landed" }]);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        triggers: [{ name: "Forecast Ready", description: "x" }],
      }),
    ).toThrow(/name/);
  });

  test("skills carry a slug, a document and the references beside it", () => {
    const descriptor = decodePluginDescriptorV1({
      ...base,
      skills: [
        {
          slug: "drafting",
          text: "---\nname: Draft\ndescription: Use this when drafting.\n---\nBody.\n",
          references: [{ path: "forms.md", text: "# Forms" }],
        },
      ],
    });
    expect(descriptor.skills).toEqual([
      {
        slug: "drafting",
        text: "---\nname: Draft\ndescription: Use this when drafting.\n---\nBody.\n",
        references: [{ path: "forms.md", text: "# Forms" }],
      },
    ]);
  });

  test("skills are bounded, uniquely named, and reference one .md file each", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [{ slug: "Draft", text: "x" }],
      }),
    ).toThrow(/slug is invalid/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [
          { slug: "drafting", text: "x" },
          { slug: "drafting", text: "y" },
        ],
      }),
    ).toThrow(/duplicate slugs/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: Array.from({ length: 9 }, (_, index) => ({
          slug: `s${index}`,
          text: "x",
        })),
      }),
    ).toThrow(/bounded array/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [
          {
            slug: "drafting",
            text: "x",
            references: [{ path: "../etc/passwd", text: "x" }],
          },
        ],
      }),
    ).toThrow(/path is invalid/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [
          {
            slug: "drafting",
            text: "x",
            references: Array.from({ length: 33 }, (_, index) => ({
              path: `r${index}.md`,
              text: "x",
            })),
          },
        ],
      }),
    ).toThrow(/bounded array/);
  });

  test("skills are bounded together, not only one at a time", () => {
    // Eight Skills each inside the per-item bound, together past what one
    // stored Composition generation should carry.
    const oversized = Array.from({ length: 8 }, (_, index) => ({
      slug: `s${index}`,
      text: "x".repeat(40_000),
    }));
    expect(() =>
      decodePluginDescriptorV1({ ...base, skills: oversized }),
    ).toThrow(/bytes of Skill text/);

    // A reference counts against the same total as the document it sits beside.
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [
          {
            slug: "drafting",
            text: "x".repeat(60_000),
            references: Array.from({ length: 4 }, (_, index) => ({
              path: `r${index}.md`,
              text: "x".repeat(60_000),
            })),
          },
        ],
      }),
    ).toThrow(/bytes of Skill text/);

    const admitted = decodePluginDescriptorV1({
      ...base,
      skills: [
        {
          slug: "drafting",
          text: "x".repeat(60_000),
          references: [{ path: "forms.md", text: "x".repeat(60_000) }],
        },
      ],
    });
    expect(admitted.skills?.[0]?.references).toHaveLength(1);
  });

  test("the aggregate bound counts encoded bytes, not UTF-16 code units", () => {
    /**
     * A `SKILL.md` of exactly `bytes` UTF-8 bytes whose body is CJK: three
     * bytes to one UTF-16 code unit, so a total counted in code units
     * admits text this bound has to refuse. Everything about the document is
     * well formed and every item is far inside the per-item bound, so the
     * encoded total is the only thing that can refuse it.
     */
    const skillText = (slug: string, bytes: number): string => {
      const header = `---\nname: ${slug}\ndescription: Use this when bounded.\n---\n\n`;
      const ascii = (bytes - header.length) % 3;
      const characters = (bytes - header.length - ascii) / 3;
      return `${header}${"x".repeat(ascii)}${"字".repeat(characters)}`;
    };
    const half = ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 / 2;
    const atBound = [
      { slug: "first", text: skillText("first", half) },
      { slug: "second", text: skillText("second", half) },
    ];

    expect(
      decodePluginDescriptorV1({ ...base, skills: atBound }).skills,
    ).toHaveLength(2);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        skills: [
          atBound[0],
          { slug: "second", text: skillText("second", half + 1) },
        ],
      }),
    ).toThrow(/bytes of Skill text/);
  });

  // ADR 0030: a card declares the values the Bot sends and the names the
  // surface may press, and nothing about how it looks.
  test("cards are bounded, uniquely named, and never shadow a declared tool", () => {
    const card = (overrides: Record<string, unknown> = {}) => ({
      id: "draft",
      displayName: "Draft",
      description: "Shows a draft.",
      dataSchema: { type: "object", properties: {} },
      actions: [{ name: "details", description: "Show the rest." }],
      ...overrides,
    });
    const decoded = decodePluginDescriptorV1({ ...base, cards: [card()] });
    expect(decoded.cards?.[0]?.actions).toEqual([
      { name: "details", description: "Show the rest." },
    ]);
    expect(pluginCardToolNameV1(base.id, "draft")).toBe("weather_draft");

    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: Array.from({ length: 17 }, (_entry, index) =>
          card({ id: `draft_${index}` }),
        ),
      }),
    ).toThrow(/bounded array/);
    expect(() =>
      decodePluginDescriptorV1({ ...base, cards: [card(), card()] }),
    ).toThrow(/duplicate ids/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [card(), card({ id: "reply" })],
      }),
    ).toThrow(/one action name on two cards/);
    expect(() =>
      decodePluginDescriptorV1({ ...base, cards: [card({ id: "Draft" })] }),
    ).toThrow(/id is invalid/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [card({ dataSchema: { type: "string" } })],
      }),
    ).toThrow(/must describe an object/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            dataSchema: { type: "object", description: "x".repeat(70_000) },
          }),
        ],
      }),
    ).toThrow(/exceeds its bound/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            actions: Array.from({ length: 17 }, (_entry, index) => ({
              name: `press_${index}`,
              description: "Press.",
            })),
          }),
        ],
      }),
    ).toThrow(/bounded array/);

    // The card's tool is offered under the name below, so a tool of the same
    // name would be two tools with one name.
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        tools: [
          {
            name: "weather_draft",
            description: "Drafts",
            inputSchema: { type: "object" },
          },
        ],
        cards: [card()],
      }),
    ).toThrow(/a card of the same name/);
  });

  // A card whose schema the kernel cannot enforce whole never mounts, rather
  // than drawing until the Bot happens to fill the unchecked field.
  test("a card's schema is refused for a constraint nothing would check", () => {
    const card = (dataSchema: Record<string, unknown>) => ({
      id: "draft",
      displayName: "Draft",
      description: "Shows a draft.",
      dataSchema,
      actions: [],
    });
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            type: "object",
            properties: { note: { type: "string", pattern: "^a" } },
          }),
        ],
      }),
    ).toThrow(/does not enforce/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            type: "object",
            properties: {},
            additionalProperties: { type: "string" },
          }),
        ],
      }),
    ).toThrow(/additionalProperties must be true or false/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            type: "object",
            properties: { tags: { type: "array", items: { type: "date" } } },
          }),
        ],
      }),
    ).toThrow(/does not declare a known type/);
    expect(
      decodePluginDescriptorV1({
        ...base,
        cards: [
          card({
            type: "object",
            properties: { note: { type: "string", maxLength: 8 } },
            required: ["note"],
            additionalProperties: false,
          }),
        ],
      }).cards?.[0]?.id,
    ).toBe("draft");
  });

  test("a settings schema describes an object and is bounded", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        settingsSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }).settingsSchema,
    ).toEqual({ type: "object", properties: { city: { type: "string" } } });
    expect(() =>
      decodePluginDescriptorV1({ ...base, settingsSchema: { type: "string" } }),
    ).toThrow(/object/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        settingsSchema: { type: "object", description: "x".repeat(70_000) },
      }),
    ).toThrow(/bound/);
  });
});
