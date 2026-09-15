"use strict";
const names = ["guardian", "pixel", "sunny"];
let report = null,
  selected = "latest",
  signature = "";
const title = (n) => n[0].toUpperCase() + n.slice(1);
const pct = (v) => (v == null ? "—" : v.toFixed(2) + "%");
document.getElementById("cards").innerHTML = names
  .map(
    (n) =>
      `<article class="card" id="${n}"><div class="card-head"><h2>${title(n)}</h2><span class="score">—</span></div><div class="comparison"><div class="views"><div class="view"><span class="label">Concept art</span><div class="stage"><img src="assets/${n}-reference.png" alt="${title(n)} locked concept"></div></div><div class="view"><span class="label">SVG</span><div class="stage"><img class="candidate" alt="${title(n)} vector conversion" hidden></div></div></div><div class="stage single"><img class="overlay-image" src="assets/${n}-reference.png" alt="${title(n)} reference overlay"><img class="candidate svg overlay-image" alt="${title(n)} SVG overlay" hidden><img class="diff" alt="${title(n)} amplified pixel differences" hidden></div></div><div class="metrics"><span>Colour agreement</span><b class="color">—</b><span>Structural similarity</span><b class="ssim">—</b><span>Edge alignment</span><b class="edge">—</b><span>Silhouette overlap</span><b class="silhouette">—</b></div><div class="card-foot"><span class="size">Tracing…</span><a class="download-svg" hidden download>Download SVG</a></div></article>`,
  )
  .join("");
document.querySelectorAll("[data-mode]").forEach((b) => {
  if (b.tagName !== "BUTTON") return;
  b.onclick = () => {
    document.body.dataset.mode = b.dataset.mode;
    document
      .querySelectorAll("button[data-mode]")
      .forEach((x) => x.setAttribute("aria-pressed", x === b));
  };
});
for (const id of ["zoom", "checker"])
  document.getElementById(id).onclick = (e) => {
    const on = document.body.classList.toggle(id);
    e.target.setAttribute("aria-pressed", on);
  };
document.getElementById("mix").oninput = (e) => {
  document.body.style.setProperty("--mix", e.target.value / 100);
  document.getElementById("mix-value").textContent = e.target.value + "%";
};
document.getElementById("version").onchange = (e) => {
  selected = e.target.value;
  render();
};
function render() {
  if (!report) return;
  const version =
    selected === "latest"
      ? report.versions.at(-1)
      : report.versions.find((v) => v.id === selected);
  document.getElementById("status").textContent = report.status || "";
  if (!version) return;
  for (const c of version.characters) {
    const card = document.getElementById(c.name);
    card.querySelector(".score").textContent = pct(c.score);
    card.querySelector(".score").classList.toggle("pass", c.score > 95);
    for (const key of ["color", "ssim", "edge", "silhouette"])
      card.querySelector("." + key).textContent = pct(c[key]);
    card.querySelectorAll(".candidate").forEach((img) => {
      img.src = c.svg + "?v=" + c.sha256.slice(0, 12);
      img.hidden = false;
    });
    const diff = card.querySelector(".diff");
    diff.src = c.diff + "?v=" + c.sha256.slice(0, 12);
    diff.hidden = false;
    card.querySelector(".size").textContent =
      `${c.paths} paths · ${(c.bytes / 1024).toFixed(1)} KB`;
    const link = card.querySelector(".download-svg");
    link.href = c.svg;
    link.hidden = false;
  }
  const lowest = Math.min(...version.characters.map((c) => c.score));
  document.getElementById("status").textContent =
    version.label +
    " · " +
    (lowest > 95
      ? "All three pass the fixed target."
      : "Below the target; retained for comparison.");
  const badge = document.getElementById("overall");
  badge.textContent =
    lowest > 95
      ? `All three above 95% · ${lowest.toFixed(2)}% minimum`
      : `Target > 95% · ${lowest.toFixed(2)}% minimum`;
  badge.classList.toggle("pass", lowest > 95);
  document.getElementById("history").innerHTML = report.versions
    .map(
      (v) =>
        `<tr><td>${v.label}</td>${names.map((n) => `<td>${pct(v.characters.find((c) => c.name === n)?.score)}</td>`).join("")}</tr>`,
    )
    .join("");
}
async function refresh() {
  try {
    const response = await fetch("report.json", { cache: "no-store" });
    if (!response.ok) throw Error("Report unavailable");
    const next = await response.json();
    const hash = JSON.stringify(next);
    if (hash === signature) return;
    signature = hash;
    report = next;
    const select = document.getElementById("version");
    select.innerHTML =
      '<option value="latest">Latest revision</option>' +
      report.versions
        .map((v) => `<option value="${v.id}">${v.label}</option>`)
        .join("");
    select.value = selected;
    render();
  } catch (e) {
    document.getElementById("status").textContent =
      "Waiting for the local comparison report…";
  }
}
refresh();
setInterval(refresh, 2500);
