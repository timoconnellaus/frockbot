"use strict";
const $ = (id) => document.getElementById(id),
  ns = "http://www.w3.org/2000/svg";
let data,
  source,
  selected,
  solo = null,
  hidden = new Set(),
  exploded = false,
  pivots = false,
  highlight = false,
  hiddenLegs = false,
  report;
function nodeFor(root, id) {
  return root.querySelector(`[data-part="${id}"]`);
}
function pivotMark(p) {
  const g = document.createElementNS(ns, "g");
  g.classList.add("pivot");
  g.innerHTML = `<circle cx="${p[0]}" cy="${p[1]}" r="9" fill="white" stroke="#9b3775" stroke-width="2"/><path d="M${p[0] - 14} ${p[1]}h28M${p[0]} ${p[1] - 14}v28" stroke="#9b3775" stroke-width="2"/>`;
  return g;
}
function render() {
  if (!data) return;
  const svg = source.cloneNode(true);
  if (solo) {
    const piece = nodeFor(svg, selected).cloneNode(true);
    svg.replaceChildren(piece);
  }
  svg.setAttribute("aria-label", data.name + " separated SVG parts");
  svg.setAttribute(
    "viewBox",
    exploded
      ? `-120 -120 ${data.width + 240} ${data.height + 250}`
      : `0 0 ${data.width} ${data.height}`,
  );
  for (const p of data.parts) {
    const g = nodeFor(svg, p.id);
    if (!g) continue;
    if (hidden.has(p.id)) g.classList.add("hidden-part");
    if (exploded)
      g.setAttribute("transform", `translate(${p.offset.join(" ")})`);
    if (pivots) g.append(pivotMark(p.pivot));
    if (highlight && p.id === selected) g.classList.add("part-selected");
  }
  if (hiddenLegs && nodeFor(svg, "fur"))
    nodeFor(svg, "fur").setAttribute("opacity", "0.22");
  $("assembly").replaceChildren(svg);
  $("list").innerHTML = "";
  for (const p of data.parts) {
    const row = document.createElement("div");
    row.className = "part-row" + (p.id === selected ? " active" : "");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !hidden.has(p.id);
    check.setAttribute("aria-label", "Show " + p.label.toLowerCase());
    check.onchange = () => {
      solo = null;
      check.checked ? hidden.delete(p.id) : hidden.add(p.id);
      render();
    };
    const btn = document.createElement("button");
    btn.textContent = p.label;
    btn.onclick = () => {
      selected = p.id;
      render();
    };
    row.append(check, btn);
    $("list").append(row);
  }
  const part = data.parts.find((p) => p.id === selected),
    isolated = document.createElementNS(ns, "svg");
  isolated.setAttribute("xmlns", ns);
  const full = nodeFor(source, selected).cloneNode(true);
  const b = part.bounds;
  const cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2;
  const size = Math.max(b[2] - b[0], b[3] - b[1], 80) + 60;
  isolated.setAttribute(
    "viewBox",
    `${cx - size / 2} ${cy - size / 2} ${size} ${size}`,
  );
  isolated.append(full);
  if (pivots) isolated.append(pivotMark(part.pivot));
  $("isolated").replaceChildren(isolated);
  $("selected-title").textContent = part.label;
  $("download-part").href = `parts/${part.file}`;
  $("asset-gallery").replaceChildren(
    ...data.parts.map((p) => {
      const card = document.createElement("button");
      card.className = "asset-card" + (p.id === selected ? " active" : "");
      card.setAttribute("aria-label", "Inspect " + p.label.toLowerCase());
      const preview = document.createElementNS(ns, "svg");
      const [x0, y0, x1, y1] = p.bounds;
      const size = Math.max(x1 - x0, y1 - y0) + 24;
      preview.setAttribute(
        "viewBox",
        `${(x0 + x1 - size) / 2} ${(y0 + y1 - size) / 2} ${size} ${size}`,
      );
      preview.append(nodeFor(source, p.id).cloneNode(true));
      const label = document.createElement("span");
      label.textContent = p.label;
      card.append(preview, label);
      card.onclick = () => {
        selected = p.id;
        render();
      };
      return card;
    }),
  );
  $("part-detail").textContent =
    `Pivot ${part.pivot.join(", ")} · complete vector asset`;
  $("only").textContent = solo ? "Show all parts" : "Only this part";
  $("explode").setAttribute("aria-pressed", exploded);
  $("pivots").setAttribute("aria-pressed", pivots);
  $("highlight").setAttribute("aria-pressed", highlight);
  $("hidden-legs").setAttribute("aria-pressed", hiddenLegs);
  $("status").textContent =
    `${data.parts.length} named parts · ${solo ? "Selected part only" : hidden.size ? "Some parts hidden for inspection" : exploded ? "Static separated view" : "Resting assembly"} · No animation`;
}
async function load() {
  const name = $("character").value;
  try {
    const responses = await Promise.all([
      fetch(`parts/${name}.json`, { cache: "no-store" }),
      fetch(`parts/${name}.svg`, { cache: "no-store" }),
      fetch("parts/validation.json", { cache: "no-store" }),
    ]);
    if (responses.some((r) => !r.ok)) throw Error("Missing asset");
    data = await responses[0].json();
    source = new DOMParser().parseFromString(
      await responses[1].text(),
      "image/svg+xml",
    ).documentElement;
    report = await responses[2].json();
    selected = "fur";
    solo = null;
    hidden.clear();
    exploded = false;
    pivots = false;
    highlight = false;
    hiddenLegs = false;
    $("original").src = `svg/${name}.svg`;
    $("download").href = `parts/${name}.svg`;
    $("count").textContent = `(${data.parts.length})`;
    const result = report.characters[name];
    $("match").textContent = result.score.toFixed(2) + "% resting match";
    $("metrics").innerHTML = Object.entries({
      "Colour agreement": result.color,
      "Structural similarity": result.ssim,
      "Edge alignment": result.edge,
      "Alpha agreement": result.alpha,
    })
      .map(([k, v]) => `<dt>${k}</dt><dd>${v.toFixed(2)}%</dd>`)
      .join("");
    render();
  } catch (e) {
    $("status").textContent = "Unable to load the parts: " + e.message;
  }
}
$("character").onchange = load;
$("explode").onclick = () => {
  exploded = !exploded;
  render();
};
$("pivots").onclick = () => {
  pivots = !pivots;
  render();
};
$("highlight").onclick = () => {
  highlight = !highlight;
  render();
};
$("hidden-legs").onclick = () => {
  hiddenLegs = !hiddenLegs;
  render();
};
$("reset").onclick = () => {
  solo = null;
  hidden.clear();
  exploded = false;
  pivots = false;
  highlight = false;
  hiddenLegs = false;
  render();
};
$("only").onclick = () => {
  solo = solo ? null : selected;
  hidden.clear();
  render();
};
load();
