const $ = (id) => document.getElementById(id);
rive.RuntimeLoader.setWasmUrl("../pixel-rive-animation/vendor/rive.wasm");
const cast = [
  ["pixel", "Shaggy hair, small ear flicks and a light bounce."],
  ["guardian", "Steady and grounded. Small gestures and a deliberate rhythm."],
  ["sunny", "Bright, buoyant and quick to celebrate."],
  ["chill", "A gentle sway and a soft body wobble."],
  ["nudge", "A rounded bounce with an encouraging little lean."],
  ["fox", "Alert ears, a curious head tilt and an expressive tail."],
  [
    "dog",
    "One ear up, one soft flick. A curious head tilt and a little tail wag.",
  ],
  ["goat", "Planted hooves, thoughtful nods and a small tail flick."],
  ["cow", "A slower sway, settled hooves and a lazy tail swish."],
  ["cat", "A seated pose, subtle head tilts and a leisurely tail."],
  ["rabbit", "A little rear-foot tap. Two very expressive ears."],
];
const captions = [
  "A quiet breath. A blink. A passing thought.",
  "Weighing an idea.",
  "A rhythm for getting things done.",
  "A small gesture: waiting for your input.",
];
const settings = {
  activity: 0,
  emotion: 0,
  follow: true,
  hover: true,
  reduced: false,
};
let instances = [],
  selected = "rabbit",
  contract = null,
  loaded = 0,
  generation = 0,
  paused = false,
  comparing = false,
  celebrationTimer = null;
let targetX = 0,
  targetY = 0,
  currentX = 0,
  currentY = 0,
  lastTime = performance.now(),
  hoverInside = false;
function set(kind, name, value) {
  for (const r of instances) {
    const p = r.viewModelInstance?.[kind](name);
    if (p) p.value = value;
  }
}
function num(name, value) {
  set("number", name, value);
}
function bool(name, value) {
  set("boolean", name, value);
}
function pressed(id, value) {
  for (const b of $(id).querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(Number(b.dataset.value) === value));
}
function resume() {
  if (paused) {
    paused = false;
    $("pause").textContent = "Pause";
    for (const r of instances) r.play(contract.stateMachine);
  }
  $("status").textContent = "Live Rive";
}
function exitCompare() {
  comparing = false;
  document.body.classList.remove("compare");
  $("reference").hidden = true;
  $("compare").textContent = "Compare to static SVG";
}
function cancelCelebration() {
  clearTimeout(celebrationTimer);
  celebrationTimer = null;
  $("celebrate").textContent = "Celebrate a success ↗";
  $("celebrate").disabled = loaded !== 2;
}
function palette(hex) {
  $("color").value = hex;
  set("color", "primary", parseInt("ff" + hex.slice(1), 16));
  const original = contract.palette?.primary ?? "#fc85ae";
  const shade =
    hex.toLowerCase() === original.toLowerCase()
      ? (contract.palette?.shade ?? "#a95d75").slice(1)
      : hex
          .slice(1)
          .match(/../g)
          .map((v) =>
            Math.round(parseInt(v, 16) * 0.67)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("");
  set("color", "shade", parseInt("ff" + shade, 16));
  for (const b of $("swatches").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.color === hex));
}
function applySettings() {
  num("activity", settings.activity);
  num("emotion", settings.emotion);
  bool("reducedMotion", settings.reduced);
  bool("hovered", false);
  palette(contract.palette?.primary ?? "#fc85ae");
}
function characterPaths(name) {
  const base =
    name === "pixel" ? "../pixel-rive-animation" : `characters/${name}/rig`;
  return {
    contract: `${base}/contract.json`,
    riv: `${base}/build/${name}.riv`,
    svg:
      name === "pixel"
        ? "../flock-svg-rig/parts/pixel.svg"
        : `characters/${name}/${name}.svg`,
  };
}
async function choose(name) {
  const request = ++generation;
  selected = name;
  loaded = 0;
  cancelCelebration();
  exitCompare();
  paused = false;
  $("pause").textContent = "Pause";
  for (const r of instances) r.cleanup();
  instances = [];
  for (const el of document.querySelectorAll("aside button,aside input"))
    el.disabled = true;
  $("pause").disabled = true;
  $("status").textContent = "Loading…";
  for (const b of $("characters").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.name === name));
  const paths = characterPaths(name);
  try {
    const response = await fetch(paths.contract);
    if (!response.ok) throw new Error("Missing character contract");
    const c = await response.json();
    if (request !== generation) return;
    contract = c;
    $("character-name").textContent = "MEET " + name.toUpperCase();
    $("personality").textContent = cast.find((x) => x[0] === name)[1];
    $("concept-review").hidden = name !== "dog";
    $("reference").src = paths.svg;
    $("download-rive").href = paths.riv;
    $("download-svg").href = paths.svg;
    $("anatomy").replaceChildren();
    for (const part of c.parts ?? [
      "fur",
      "eye-left",
      "eye-right",
      "ear-left",
      "ear-right",
      "foot-left",
      "foot-right",
    ]) {
      const tag = document.createElement("span");
      tag.textContent = part.replace("fur", "body").replaceAll("-", " ");
      $("anatomy").append(tag);
    }
    const original = $("swatches").querySelector("button");
    original.dataset.color = c.palette?.primary ?? "#fc85ae";
    original.style.setProperty("--swatch", original.dataset.color);
    original.setAttribute("aria-label", "Original colour");
    for (const canvas of [$("pixel"), $("small")]) {
      const r = new rive.Rive({
        src: paths.riv,
        canvas,
        artboard: c.artboard,
        stateMachine: c.stateMachine,
        autoplay: true,
        autoBind: true,
        layout: new rive.Layout({
          fit: rive.Fit.Contain,
          alignment: rive.Alignment.Center,
        }),
        onLoad() {
          if (request !== generation) {
            r.cleanup();
            return;
          }
          r.resizeDrawingSurfaceToCanvas();
          loaded++;
          if (loaded === 2) {
            applySettings();
            $("status").textContent = "Live Rive";
            $("pause").disabled = false;
            for (const el of document.querySelectorAll(
              "aside button,aside input",
            ))
              el.disabled = false;
          }
        },
        onLoadError(e) {
          if (request === generation)
            $("status").textContent = "Could not load character";
          console.error(e);
        },
      });
      instances.push(r);
    }
    history.replaceState(null, "", `?character=${name}`);
  } catch (e) {
    $("status").textContent = "Could not load character";
    console.error(e);
  }
}
for (const [name] of cast) {
  const b = document.createElement("button");
  b.dataset.name = name;
  b.setAttribute("aria-label", name[0].toUpperCase() + name.slice(1));
  b.setAttribute("aria-pressed", "false");
  const img = document.createElement("img");
  img.src = characterPaths(name).svg;
  img.alt = "";
  b.append(img, document.createTextNode(name[0].toUpperCase() + name.slice(1)));
  b.addEventListener("click", () => choose(name));
  $("characters").append(b);
}
new ResizeObserver(() =>
  instances.forEach((r) => r.resizeDrawingSurfaceToCanvas()),
).observe($("stage"));
$("activities").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  cancelCelebration();
  exitCompare();
  resume();
  settings.activity = Number(b.dataset.value);
  num("activity", settings.activity);
  num("emotion", settings.emotion);
  pressed("activities", settings.activity);
  $("caption").textContent = captions[settings.activity];
});
$("emotions").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  cancelCelebration();
  exitCompare();
  resume();
  settings.emotion = Number(b.dataset.value);
  num("activity", settings.activity);
  num("emotion", settings.emotion);
  pressed("emotions", settings.emotion);
});
$("swatches").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) {
    exitCompare();
    resume();
    palette(b.dataset.color);
  }
});
$("color").addEventListener("input", (e) => {
  exitCompare();
  resume();
  palette(e.target.value);
});
$("follow").addEventListener("change", (e) => {
  settings.follow = e.target.checked;
  if (!settings.follow) targetX = targetY = 0;
});
$("hover").addEventListener("change", (e) => {
  settings.hover = e.target.checked;
  if (!settings.hover) bool("hovered", false);
});
$("reduce").addEventListener("change", (e) => {
  exitCompare();
  settings.reduced = e.target.checked;
  bool("reducedMotion", settings.reduced);
  if (settings.reduced) {
    targetX = targetY = 0;
    bool("hovered", false);
  }
  $("caption").textContent = settings.reduced
    ? "A still, neutral pose."
    : captions[settings.activity];
});
$("pause").addEventListener("click", () => {
  paused = !paused;
  for (const r of instances)
    paused ? r.pause(contract.stateMachine) : r.play(contract.stateMachine);
  $("pause").textContent = paused ? "Resume" : "Pause";
  $("status").textContent = paused ? "Paused" : "Live Rive";
});
$("celebrate").addEventListener("click", () => {
  exitCompare();
  resume();
  cancelCelebration();
  num("activity", 4);
  num("emotion", 1);
  $("celebrate").disabled = true;
  $("celebrate").textContent = "A little victory!";
  celebrationTimer = setTimeout(() => {
    num("activity", settings.activity);
    num("emotion", settings.emotion);
    cancelCelebration();
  }, 2600);
});
$("compare").addEventListener("click", () => {
  if (comparing) {
    exitCompare();
    $("status").textContent = paused ? "Paused" : "Live Rive";
    return;
  }
  comparing = true;
  document.body.classList.add("compare");
  $("reference").hidden = false;
  $("compare").textContent = "Back to animation";
  $("status").textContent = "Static SVG";
});
const clamp = (v) => Math.max(-1, Math.min(1, v));
document.addEventListener("pointermove", (e) => {
  const b = $("stage").getBoundingClientRect();
  if (settings.follow && !settings.reduced && !comparing) {
    targetX = clamp((e.clientX - b.left - b.width * 0.51) / (b.width * 0.5));
    targetY = clamp((e.clientY - b.top - b.height * 0.49) / (b.height * 0.5));
  }
  const x = (e.clientX - b.left) / b.width,
    y = (e.clientY - b.top) / b.height;
  const inside = x > 0.15 && x < 0.86 && y > 0.15 && y < 0.92;
  if (inside !== hoverInside) {
    hoverInside = inside;
    bool(
      "hovered",
      inside && settings.hover && !settings.reduced && !comparing,
    );
  }
});
document.addEventListener("pointerleave", () => {
  targetX = targetY = 0;
  hoverInside = false;
  bool("hovered", false);
});
function frame(t) {
  const k = 1 - Math.exp(-Math.min(t - lastTime, 60) / 105);
  lastTime = t;
  if (!paused) {
    currentX += (targetX - currentX) * k;
    currentY += (targetY - currentY) * k;
    num("lookX", currentX);
    num("lookY", currentY);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  settings.reduced = true;
  $("reduce").checked = true;
}
const initial = new URLSearchParams(location.search).get("character");
choose(cast.some((x) => x[0] === initial) ? initial : "rabbit");
