import { describe, expect, test } from "bun:test";
import {
  renderCapabilities,
  replaceCapabilityRegion,
  validateCapabilityData,
} from "../scripts/render-capabilities";

const source = await Bun.file(
  new URL("../content/capabilities.json", import.meta.url),
).json();
const data = validateCapabilityData(source);
const { matchesCapability } = await import(
  new URL("../public/how-it-works/capabilities.js", import.meta.url).href
);
const filters = {
  query: "",
  type: "all",
  category: "all",
  platform: "all",
  status: "all",
};
const filterRecord = (id: string) => {
  const row = data.capabilities.find((capability) => capability.id === id);
  if (!row) throw new Error(`Missing capability ${id}`);
  return {
    ...row,
    search: [row.name, row.description, row.category, ...row.notes].join(" "),
  };
};

async function elements(html: string, selector: string) {
  const found: {
    tag: string;
    attributes: Record<string, string>;
    text: string;
  }[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        found.push({
          tag: element.tagName,
          attributes: Object.fromEntries(element.attributes),
          text: "",
        });
      },
      text(chunk) {
        found[found.length - 1].text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found;
}

describe("capability reference", () => {
  test("preserves the complete inventory and nine-platform map", () => {
    expect(data.platforms.map(({ name }) => name)).toEqual([
      "Web",
      "Android",
      "iPhone",
      "macOS",
      "Windows",
      "Linux",
      "Apple Watch",
      "Wear OS",
      "Browser extension",
    ]);
    expect(
      Object.fromEntries(
        data.types.map(({ id }) => [
          id,
          data.capabilities.filter((row) => row.type === id).length,
        ]),
      ),
    ).toEqual({
      slot: 41,
      entry: 18,
      trigger: 25,
      handler: 14,
      action: 50,
    });
    for (const row of data.capabilities) {
      if (row.scope === "device")
        expect(Object.keys(row.platforms)).toHaveLength(9);
    }
    expect(filterRecord("local-shell").scope).toBe("device");
    expect(filterRecord("webhook").scope).toBe("cloud");
  });

  test("renders every capability without JavaScript and cloud capabilities only once", async () => {
    const html = renderCapabilities(source);
    const rows = await elements(html, "[data-capability-row]");
    expect(rows).toHaveLength(148);
    const groups = await elements(html, "details[data-capability-group]");
    expect(groups).toHaveLength(5);
    expect(
      new Set(rows.map((row) => row.attributes["aria-labelledby"])).size,
    ).toBe(148);
    expect(rows.every((row) => !Object.hasOwn(row.attributes, "hidden"))).toBe(
      true,
    );
    const cloud = rows.filter(
      (row) => row.attributes["data-scope"] === "cloud",
    );
    expect(cloud).toHaveLength(10);
    expect(
      cloud.every(
        (row) =>
          !Object.keys(row.attributes).some((name) =>
            name.startsWith("data-platform-"),
          ),
      ),
    ).toBe(true);
    const labels = await elements(html, "label");
    const controls = await elements(html, "input, select");
    expect(labels.map((label) => label.attributes.for)).toEqual(
      controls.map((control) => control.attributes.id),
    );
    const liveCount = await elements(html, "[data-capability-count]");
    expect(liveCount[0].attributes["aria-live"]).toBe("polite");
    expect(liveCount[0].text).toContain("148 capabilities");
    const category = await elements(html, 'select[name="category"]');
    expect(category).toHaveLength(1);
    const comparisonRows = await elements(
      html,
      "[data-capability-comparison-row]",
    );
    expect(comparisonRows).toHaveLength(148);
    const comparison = await elements(html, "[data-capability-comparison]");
    expect(comparison).toHaveLength(1);
  });

  test("escapes contributed text and attributes instead of accepting markup", async () => {
    const input = structuredClone(source);
    input.capabilities[0].name = '<img src=x onerror="bad()"> & card';
    input.capabilities[0].description =
      "Use 'quotes' & <script>alert(1)</script>";
    const html = renderCapabilities(input);
    expect(await elements(html, "img, script")).toEqual([]);
    const headings = await elements(html, "#capability-conversation-card");
    // HTMLRewriter exposes text chunks in their encoded form.
    expect(headings[0].text).toContain("&lt;img");
    const rows = await elements(html, "[data-capability-row]");
    expect(rows[0].attributes["data-search"]).toContain(
      "&lt;img src=x onerror=&quot;bad()&quot;&gt;",
    );
  });

  test("rejects duplicate ids, incomplete platform maps and invalid statuses", () => {
    const duplicate = structuredClone(source);
    duplicate.capabilities.push(duplicate.capabilities[0]);
    expect(() => validateCapabilityData(duplicate)).toThrow(
      "Capability ids must be unique",
    );
    const incomplete = structuredClone(source);
    delete incomplete.capabilities[0].platforms.iphone;
    expect(() => validateCapabilityData(incomplete)).toThrow(
      "all nine platform statuses are required",
    );
    const invalid = structuredClone(source);
    invalid.capabilities[0].platforms.web = "released";
    expect(() => validateCapabilityData(invalid)).toThrow(
      "conversation-card/web must be one of",
    );
    const duplicatedRuntime = structuredClone(source);
    const runtime = duplicatedRuntime.capabilities.find(
      (row: { scope: string }) => row.scope === "cloud",
    );
    runtime.platforms = incomplete.capabilities[0].platforms;
    expect(() => validateCapabilityData(duplicatedRuntime)).toThrow(
      "must not duplicate platform statuses",
    );
  });

  test("replaces only the bounded generated region and stays deterministic", () => {
    const html =
      "<main>Article</main>\n<!-- capabilities:start -->old<!-- capabilities:end -->\n<footer>Links</footer>";
    const rendered = renderCapabilities(source);
    expect(renderCapabilities(source)).toBe(rendered);
    const result = replaceCapabilityRegion(html, rendered);
    expect(
      result.startsWith("<main>Article</main>\n<!-- capabilities:start -->\n"),
    ).toBe(true);
    expect(
      result.endsWith("\n<!-- capabilities:end -->\n<footer>Links</footer>"),
    ).toBe(true);
    expect(replaceCapabilityRegion(result, rendered)).toBe(result);
    expect(() => replaceCapabilityRegion("No markers", rendered)).toThrow(
      "exactly one",
    );
    expect(() =>
      replaceCapabilityRegion(
        "<!-- capabilities:end --><!-- capabilities:start -->",
        rendered,
      ),
    ).toThrow("wrong order");
  });
});

describe("capability filters", () => {
  test("combines type, search, platform and status", () => {
    const card = filterRecord("conversation-card");
    expect(matchesCapability(card, filters)).toBe(true);
    expect(
      matchesCapability(card, {
        ...filters,
        query: " CARD  conversation ",
        type: "slot",
        platform: "android",
        status: "available",
      }),
    ).toBe(true);
    expect(matchesCapability(card, { ...filters, type: "action" })).toBe(false);
    expect(
      matchesCapability(card, {
        ...filters,
        category: "In the conversation",
      }),
    ).toBe(true);
    expect(
      matchesCapability(card, { ...filters, category: "System control" }),
    ).toBe(false);
    expect(matchesCapability(card, { ...filters, query: "calendar" })).toBe(
      false,
    );
    expect(
      matchesCapability(card, {
        ...filters,
        platform: "iphone",
        status: "available",
      }),
    ).toBe(false);
    expect(
      matchesCapability(card, {
        ...filters,
        platform: "iphone",
        status: "planned",
      }),
    ).toBe(true);
  });

  test("platform alone shows applicable capabilities while No equivalent remains searchable", () => {
    const shell = filterRecord("local-shell");
    expect(matchesCapability(shell, { ...filters, platform: "macos" })).toBe(
      true,
    );
    expect(matchesCapability(shell, { ...filters, platform: "iphone" })).toBe(
      false,
    );
    expect(
      matchesCapability(shell, {
        ...filters,
        platform: "iphone",
        status: "not-applicable",
      }),
    ).toBe(true);
  });

  test("retains shared cloud capabilities for any platform and respects their status", () => {
    const webhook = filterRecord("webhook");
    for (const platform of data.platforms) {
      expect(
        matchesCapability(webhook, {
          ...filters,
          platform: platform.id,
          status: "available",
        }),
      ).toBe(true);
    }
    expect(matchesCapability(webhook, { ...filters, status: "planned" })).toBe(
      false,
    );
    expect(
      matchesCapability(webhook, { ...filters, status: "not-applicable" }),
    ).toBe(false);
    expect(
      matchesCapability(filterRecord("routing-handler"), {
        ...filters,
        platform: "wear-os",
        status: "planned",
      }),
    ).toBe(true);
  });

  test("search finds constraint notes and reset values restore the full inventory", () => {
    expect(
      matchesCapability(filterRecord("location-trigger"), {
        ...filters,
        query: "store review",
      }),
    ).toBe(true);
    const matched = data.capabilities.filter((row) =>
      matchesCapability(filterRecord(row.id), filters),
    );
    expect(matched).toHaveLength(148);
  });
});
