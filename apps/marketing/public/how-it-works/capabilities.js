/** A cloud capability is shared, so selecting a device never hides it. */
export function matchesCapability(capability, filters) {
  if (filters.type !== "all" && capability.type !== filters.type) return false;
  if (filters.category !== "all" && capability.category !== filters.category)
    return false;
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.every((term) => capability.search.toLowerCase().includes(term))) {
    return false;
  }
  const statuses =
    capability.scope === "cloud"
      ? [capability.status]
      : filters.platform === "all"
        ? Object.values(capability.platforms)
        : [capability.platforms[filters.platform]];
  return filters.status === "all"
    ? statuses.some((status) => status === "available" || status === "planned")
    : statuses.includes(filters.status);
}

export function initialiseCapabilityReference(reference) {
  const form = reference.querySelector("[data-capability-filters]");
  const count = reference.querySelector("[data-capability-count]");
  const empty = reference.querySelector("[data-capability-empty]");
  if (!form || !count || !empty) return;
  const platformIds = Array.from(
    form.querySelectorAll('[name="platform"] option'),
  )
    .map((option) => option.value)
    .filter((platform) => platform !== "all");
  const groups = Array.from(
    reference.querySelectorAll("[data-capability-group]"),
  );
  const categories = Array.from(
    reference.querySelectorAll("[data-capability-category]"),
  );
  const entries = Array.from(
    reference.querySelectorAll("[data-capability-row]"),
  ).map((element) => ({
    element,
    capability: {
      type: element.getAttribute("data-capability-type"),
      category: element.getAttribute("data-capability-category-value"),
      scope: element.getAttribute("data-scope"),
      status: element.getAttribute("data-runtime-status"),
      search: element.getAttribute("data-search") ?? "",
      platforms: Object.fromEntries(
        platformIds.map((platform) => [
          platform,
          element.getAttribute(`data-platform-${platform}`),
        ]),
      ),
    },
  }));
  const value = (name) => form.querySelector(`[name="${name}"]`).value;
  const update = () => {
    const filters = {
      query: value("query"),
      type: value("type"),
      category: value("category"),
      platform: value("platform"),
      status: value("status"),
    };
    const filtering =
      filters.query.trim() !== "" ||
      [filters.type, filters.category, filters.platform, filters.status].some(
        (filter) => filter !== "all",
      );
    let visible = 0;
    for (const { element, capability } of entries) {
      element.hidden = !matchesCapability(capability, filters);
      if (!element.hidden) visible += 1;
    }
    const visibleIds = new Set(
      entries
        .filter(({ element }) => !element.hidden)
        .map(({ element }) => element.getAttribute("data-capability-id")),
    );
    for (const row of reference.querySelectorAll(
      "[data-capability-comparison-row]",
    )) {
      row.hidden = !visibleIds.has(
        row.getAttribute("data-capability-comparison-row"),
      );
    }
    for (const category of categories) {
      category.hidden = !category.querySelector(
        "[data-capability-row]:not([hidden])",
      );
    }
    let visibleGroups = 0;
    for (const group of groups) {
      const total = group.querySelectorAll(
        "[data-capability-row]:not([hidden])",
      ).length;
      group.hidden = total === 0;
      group.querySelector("[data-capability-group-count]").textContent = total;
      if (total > 0) visibleGroups += 1;
      group.open = filtering && total > 0;
    }
    count.textContent = `${visible} ${visible === 1 ? "capability" : "capabilities"} across ${visibleGroups} surface ${visibleGroups === 1 ? "type" : "types"}.${filtering ? " Shared cloud capabilities apply to every platform." : ""}`;
    empty.hidden = visible !== 0;
  };
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  // A browser may flush microtasks before applying the form's default reset.
  form.addEventListener("reset", () => setTimeout(update, 0));
  form.hidden = false;
  update();
}

if (typeof document !== "undefined") {
  document
    .querySelectorAll("[data-capability-reference]")
    .forEach(initialiseCapabilityReference);
}
