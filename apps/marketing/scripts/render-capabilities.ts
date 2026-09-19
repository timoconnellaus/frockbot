const PLATFORM_IDS = [
  "web",
  "android",
  "iphone",
  "macos",
  "windows",
  "linux",
  "apple-watch",
  "wear-os",
  "browser-extension",
] as const;
const TYPE_IDS = ["slot", "entry", "trigger", "handler", "action"] as const;
const STATUSES = ["available", "planned", "not-applicable"] as const;
type Status = (typeof STATUSES)[number];
type PlatformId = (typeof PLATFORM_IDS)[number];
type TypeId = (typeof TYPE_IDS)[number];
type CapabilityBase = {
  id: string;
  type: TypeId;
  category: string;
  name: string;
  description: string;
  notes: string[];
};
export type Capability = CapabilityBase &
  (
    | { scope: "cloud"; status: Status }
    | { scope: "device"; platforms: Record<PlatformId, Status> }
  );
export type CapabilityData = {
  version: 1;
  platforms: { id: PlatformId; name: string }[];
  types: { id: TypeId; name: string; plural: string; description: string }[];
  capabilities: Capability[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}
function choice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${label} must be one of ${choices.join(", ")}`);
  }
  return value;
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`${label} must be unique`);
}

export function validateCapabilityData(input: unknown): CapabilityData {
  const data = object(input, "Capability data");
  if (data.version !== 1)
    throw new Error("Unsupported capability data version");
  const platforms = array(data.platforms, "Platforms").map((item) => {
    const entry = object(item, "Platform");
    return {
      id: choice(entry.id, PLATFORM_IDS, "Platform id"),
      name: string(entry.name, "Platform name"),
    };
  });
  unique(
    platforms.map(({ id }) => id),
    "Platform ids",
  );
  if (platforms.length !== PLATFORM_IDS.length)
    throw new Error("All nine platforms must be declared");
  const types = array(data.types, "Types").map((item) => {
    const entry = object(item, "Type");
    return {
      id: choice(entry.id, TYPE_IDS, "Type id"),
      name: string(entry.name, "Type name"),
      plural: string(entry.plural, "Type plural"),
      description: string(entry.description, "Type description"),
    };
  });
  unique(
    types.map(({ id }) => id),
    "Type ids",
  );
  if (types.length !== TYPE_IDS.length)
    throw new Error("All five surface types must be declared");
  const capabilities = array(data.capabilities, "Capabilities").map(
    (item): Capability => {
      const entry = object(item, "Capability");
      const id = string(entry.id, "Capability id");
      if (!/^[a-z][a-z0-9-]*$/.test(id))
        throw new Error(`Invalid capability id: ${id}`);
      const notes =
        entry.notes === undefined
          ? []
          : array(entry.notes, `${id} notes`).map((note) =>
              string(note, `${id} note`),
            );
      const base: CapabilityBase = {
        id,
        type: choice(entry.type, TYPE_IDS, `${id} type`),
        category: string(entry.category, `${id} category`),
        name: string(entry.name, `${id} name`),
        description: string(entry.description, `${id} description`),
        notes,
      };
      if (entry.scope === "cloud") {
        if (entry.platforms !== undefined)
          throw new Error(
            `${id}: shared cloud capabilities must not duplicate platform statuses`,
          );
        return {
          ...base,
          scope: "cloud",
          status: choice(entry.status, STATUSES, `${id} status`),
        };
      }
      if (entry.scope !== "device") throw new Error(`${id}: invalid scope`);
      if (entry.status !== undefined)
        throw new Error(
          `${id}: device capabilities require per-platform statuses`,
        );
      const map = object(entry.platforms, `${id} platforms`);
      if (Object.keys(map).length !== PLATFORM_IDS.length)
        throw new Error(`${id}: all nine platform statuses are required`);
      const statuses = Object.fromEntries(
        PLATFORM_IDS.map((platform) => [
          platform,
          choice(map[platform], STATUSES, `${id}/${platform}`),
        ]),
      ) as Record<PlatformId, Status>;
      return { ...base, scope: "device", platforms: statuses };
    },
  );
  unique(
    capabilities.map(({ id }) => id),
    "Capability ids",
  );
  for (const type of TYPE_IDS) {
    if (!capabilities.some((row) => row.type === type))
      throw new Error(`No capabilities declared for ${type}`);
  }
  return { version: 1, platforms, types, capabilities };
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
const STATUS_LABELS: Record<Status, string> = {
  available: "Available today",
  planned: "In the plan",
  "not-applicable": "No equivalent",
};

function renderRow(
  row: Capability,
  platforms: CapabilityData["platforms"],
): string {
  const search = [row.name, row.description, row.category, ...row.notes]
    .join(" ")
    .toLowerCase();
  const statuses =
    row.scope === "cloud"
      ? `data-runtime-status="${row.status}"`
      : platforms
          .map(({ id }) => `data-platform-${id}="${row.platforms[id]}"`)
          .join(" ");
  const availability =
    row.scope === "cloud"
      ? `<p class="capability-cloud-status capability-status--${row.status}"><span>${STATUS_LABELS[row.status]}</span> · Shared cloud runtime</p>`
      : `<dl class="capability-platforms">${STATUSES.map((status) => {
          const names = platforms
            .filter(({ id }) => row.platforms[id] === status)
            .map(({ name }) => escapeHtml(name));
          return names.length
            ? `<div class="capability-status--${status}"><dt>${STATUS_LABELS[status]}</dt><dd>${names.join(", ")}</dd></div>`
            : "";
        }).join("")}</dl>`;
  return `<article class="capability-row" data-capability-row data-capability-type="${row.type}" data-scope="${row.scope}" ${statuses} data-search="${escapeHtml(search)}" aria-labelledby="capability-${row.id}">
<h5 id="capability-${row.id}">${escapeHtml(row.name)}</h5>
<p class="capability-description">${escapeHtml(row.description)}</p>
${availability}
${row.notes.map((note) => `<p class="capability-note">${escapeHtml(note)}</p>`).join("\n")}
</article>`;
}

export function renderCapabilities(input: unknown): string {
  const data = validateCapabilityData(input);
  const options = (items: { id: string; name: string }[]) =>
    items
      .map(
        ({ id, name }) =>
          `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`,
      )
      .join("");
  return `<!-- prettier-ignore -->
<div class="capability-reference" data-capability-reference>
<p class="capability-intro">Explore the full intended range. <strong>Available today</strong> means the capability is implemented; it does not mean every client has been publicly released. <strong>In the plan</strong> is a proposed FrockBot integration. <strong>No equivalent</strong> means this map has no corresponding surface on that platform.</p>
<p class="capability-intro">Device features depend on a connected client, permissions, hardware, operating-system APIs and background limits. Web support varies by browser. Planned rows describe the direction, not a promise of identical behaviour everywhere. Shared cloud features work independently of which client you use.</p>
<form class="capability-filters" data-capability-filters hidden role="search" aria-label="Filter capabilities">
<div class="capability-filter capability-filter--search"><label for="capability-query">Find a capability</label><input id="capability-query" name="query" type="search" placeholder="Try clipboard, voice, webhook…" autocomplete="off"></div>
<div class="capability-filter"><label for="capability-type">Surface type</label><select id="capability-type" name="type"><option value="all">All types</option>${options(data.types)}</select></div>
<div class="capability-filter"><label for="capability-platform">Platform</label><select id="capability-platform" name="platform"><option value="all">All platforms</option>${options(data.platforms)}</select></div>
<div class="capability-filter"><label for="capability-status">Status</label><select id="capability-status" name="status"><option value="all">All statuses</option>${options(STATUSES.map((id) => ({ id, name: STATUS_LABELS[id] })))}</select></div>
<button class="capability-reset" type="reset">Reset filters</button>
</form>
<p class="capability-result-count" data-capability-count role="status" aria-live="polite" aria-atomic="true">${data.capabilities.length} capabilities across ${data.types.length} surface types.</p>
<p class="capability-empty" data-capability-empty hidden>No capabilities match these filters. Try a broader search or reset the filters.</p>
${data.types
  .map((type) => {
    const rows = data.capabilities.filter((row) => row.type === type.id);
    const categories = [...new Set(rows.map((row) => row.category))];
    return `<details class="capability-group" data-capability-group="${type.id}">
<summary><span class="capability-group-heading" role="heading" aria-level="3">${escapeHtml(type.plural)} <span class="capability-group-count" data-capability-group-count>${rows.length}</span></span><span class="capability-group-description">${escapeHtml(type.description)}</span></summary>
${categories
  .map(
    (
      category,
    ) => `<section class="capability-category" data-capability-category>
<h4>${escapeHtml(category)}</h4>
<div class="capability-rows">${rows
      .filter((row) => row.category === category)
      .map((row) => renderRow(row, data.platforms))
      .join("\n")}</div>
</section>`,
  )
  .join("\n")}
</details>`;
  })
  .join("\n")}
</div>`;
}

const START = "<!-- capabilities:start -->";
const END = "<!-- capabilities:end -->";
export function replaceCapabilityRegion(
  html: string,
  rendered: string,
): string {
  if (html.split(START).length !== 2 || html.split(END).length !== 2) {
    throw new Error(
      "The page must contain exactly one capabilities:start / capabilities:end marker pair",
    );
  }
  const start = html.indexOf(START) + START.length;
  const end = html.indexOf(END);
  if (end < start) throw new Error("Capability markers are in the wrong order");
  const markerLine = html.slice(
    html.lastIndexOf("\n", start - START.length) + 1,
    start - START.length,
  );
  const indent = /^\s*$/.test(markerLine) ? markerLine : "";
  // Prettier indents the ignored element's opening line, but preserves its body.
  const aligned = rendered.replace(
    /^(<!-- prettier-ignore -->\n)(<div)/,
    `${indent}$1${indent}$2`,
  );
  return `${html.slice(0, start)}\n${aligned}\n${indent}${html.slice(end)}`;
}

if (import.meta.main) {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check"))
    throw new Error("Usage: bun scripts/render-capabilities.ts [--check]");
  const source = Bun.file(
    new URL("../content/capabilities.json", import.meta.url),
  );
  const page = Bun.file(
    new URL("../public/how-it-works/index.html", import.meta.url),
  );
  const before = await page.text();
  const after = replaceCapabilityRegion(
    before,
    renderCapabilities(await source.json()),
  );
  if (arguments_.includes("--check")) {
    if (before !== after) {
      console.error(
        "Capability reference is stale. Run bun scripts/render-capabilities.ts in apps/marketing.",
      );
      process.exitCode = 1;
    } else console.log("Capability reference is up to date.");
  } else {
    if (before !== after) await Bun.write(page, after);
    console.log("Rendered capability reference.");
  }
}
