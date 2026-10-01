// The flock on the homepage. Each character starts as its PNG and becomes its
// Rive rig (the same file the apps use) once it scrolls into view, so its eyes
// can follow the pointer. Poke one and it ducks; each has its own way of
// arriving; a few have something to say. Without script, wasm or motion, the
// PNGs stay exactly as they were.
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const images = document.querySelectorAll(
    "img.peek, img.follow, img.romp, img.feature-character, img.use-character",
  );
  if (!images.length) return;

  const EMOTION = { excited: 1, sad: 2, tired: 3, curious: 4, content: 5 };
  const SURPRISED = 6;

  // Only a few speak, so a line still lands as a surprise.
  const LINES = {
    "why-nudge": "I'll remind you. Then again.",
    "how-cat": "I'd have knocked Approve off the table.",
    "pricing-chill": "Extra bots are free. So are naps.",
  };
  const FED_UP = ["…fine.", "Rude.", "I was busy.", "Okay, okay."];

  const ease = {
    duck: "cubic-bezier(0.5, 0, 0.75, 0)",
    spring: "cubic-bezier(0.34, 1.56, 0.5, 1)",
    soft: "cubic-bezier(0.45, 0, 0.55, 1)",
  };

  const critters = [];
  for (const image of images) {
    const name = image.src.match(/characters\/([a-z]+)\.png/)?.[1];
    if (!name) continue;
    const element = document.createElement("span");
    element.className = image.className;
    element.classList.add("critter");
    const body = document.createElement("span");
    body.className = "critter-body";
    image.className = "";
    image.replaceWith(element);
    body.append(image);
    element.append(body);
    const spot = element.className.match(/follow-([a-z]+-[a-z]+)/)?.[1];
    critters.push({
      name,
      element,
      body,
      hero: element.classList.contains("peek"),
      edge: element.classList.contains("follow-edge"),
      romp: element.classList.contains("romp"),
      // On a card: it idles, watches the pointer and greets the card's hover.
      card: element.matches(".feature-character, .use-character")
        ? element.closest(".feature-card, .use-card")
        : null,
      line: spot ? LINES[spot] : undefined,
      said: false,
      visible: false,
      rig: null,
      look: { x: 0, y: 0 },
      glance: null,
      out: false,
      busy: false,
      pokes: 0,
      lastPoke: 0,
    });
  }

  const glanceAt = (critter, glance) => {
    critter.glance = glance;
    schedule();
  };
  const set = (critter, kind, name, value) => {
    const property = critter.rig?.viewModelInstance?.[kind](name);
    if (property) property.value = value;
  };
  const feel = (critter, emotion, ms) => {
    set(critter, "number", "emotion", emotion);
    clearTimeout(critter.feeling);
    critter.feeling = setTimeout(
      () => set(critter, "number", "emotion", 0),
      ms,
    );
  };

  // Where a character goes when it hides: the hero sinks along --dx/--dy,
  // the rest drop back to --hx/--hy behind their card or the screen's edge.
  const offsets = (critter) => {
    const style = getComputedStyle(critter.element);
    const read = (name) => style.getPropertyValue(name).trim() || "0px";
    const [x, y] = critter.hero ? ["--dx", "--dy"] : ["--hx", "--hy"];
    const current = style.translate === "none" ? "0px 0px" : style.translate;
    return { hidden: [read(x), read(y)], current };
  };

  // The things a character hides behind, which a poke must not reach through.
  const covers = (critter) => {
    if (critter.hero)
      return document.querySelectorAll(
        ".hero-stage .demo-window, .hero-stage .demo-phone",
      );
    if (critter.romp) return document.querySelectorAll(".app-count");
    return critter.edge || critter.card ? [] : [critter.element.parentElement];
  };
  const inside = (rect, x, y) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  // Screen vectors into the character's own frame, which may be rotated,
  // mirrored or scaled with the hero stage.
  const frame = (critter) => {
    const element = critter.element;
    const rect = element.getBoundingClientRect();
    const host = element.offsetParent;
    const scale = host
      ? host.getBoundingClientRect().width / host.offsetWidth || 1
      : 1;
    const m = new DOMMatrix(getComputedStyle(element).transform);
    const det = m.a * m.d - m.b * m.c || 1;
    return {
      rect,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      scale,
      width: element.offsetWidth,
      height: element.offsetHeight,
      local(dx, dy) {
        const x = dx / scale;
        const y = dy / scale;
        return [(m.d * x - m.c * y) / det, (-m.b * x + m.a * y) / det];
      },
    };
  };

  const critterAt = (x, y) => {
    for (const critter of critters) {
      if (!critter.visible) continue;
      const f = frame(critter);
      if (!f.width || !inside(f.rect, x, y)) continue;
      const [lx, ly] = f.local(x - f.cx, y - f.cy);
      if (Math.abs(lx) > f.width * 0.4 || Math.abs(ly) > f.height * 0.44)
        continue;
      let covered = false;
      for (const cover of covers(critter))
        if (inside(cover.getBoundingClientRect(), x, y)) covered = true;
      if (!covered) return critter;
    }
    return null;
  };

  // Speech bubbles hang above the character in page coordinates, so they
  // are never clipped by the section the character hides in.
  const say = (critter, text, ms = 3000) => {
    const rect = critter.element.getBoundingClientRect();
    const bubble = document.createElement("span");
    bubble.className = "critter-bubble";
    bubble.setAttribute("aria-hidden", "true");
    bubble.textContent = text;
    document.body.append(bubble);
    const width = bubble.offsetWidth;
    const left = Math.max(
      12,
      Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2),
    );
    bubble.style.left = `${left + scrollX}px`;
    bubble.style.top = `${Math.max(8, rect.top + rect.height * 0.08 + scrollY - bubble.offsetHeight)}px`;
    bubble.style.setProperty(
      "--tail",
      `${Math.max(14, Math.min(width - 14, rect.left + rect.width / 2 - left))}px`,
    );
    setTimeout(() => {
      bubble.classList.add("is-leaving");
      setTimeout(() => bubble.remove(), 260);
    }, ms);
  };

  // A poke ducks the character. The second time it comes back only as far
  // as its eyes; by the third it has had enough.
  const poke = (critter) => {
    if (critter.busy && !still) return;
    const now = performance.now();
    critter.pokes = now - critter.lastPoke < 5000 ? critter.pokes + 1 : 1;
    critter.lastPoke = now;
    if (still) {
      say(critter, critter.pokes >= 3 ? FED_UP[0] : "Hi.", 1800);
      return;
    }
    if (critter.romp || critter.card) {
      startle(critter);
      return;
    }
    critter.busy = true;
    const { hidden, current } = offsets(critter);
    const down = hidden.join(" ");
    const peeking = `calc(${hidden[0]} * 0.6) calc(${hidden[1]} * 0.6)`;
    const fedUp = critter.pokes >= 3;
    if (fedUp) {
      say(critter, FED_UP[Math.floor(Math.random() * FED_UP.length)], 2200);
      critter.pokes = 0;
      feel(critter, EMOTION.sad, 3600);
    } else feel(critter, SURPRISED, 2400);
    const steps =
      critter.pokes === 2
        ? [
            [current, 0, ease.duck],
            [down, 160, "linear"],
            [down, 1100, ease.spring],
            [peeking, 420, "linear"],
            [peeking, 1000, ease.spring],
            [current, 640],
          ]
        : [
            [current, 0, ease.duck],
            [down, 160, "linear"],
            [down, fedUp ? 2600 : 650, ease.spring],
            [current, 640],
          ];
    const total = steps.reduce((sum, step) => sum + step[1], 0);
    let at = 0;
    const keyframes = steps.map(([translate, ms, easing]) => {
      at += ms;
      return { translate, offset: at / total, ...(easing && { easing }) };
    });
    critter.element.animate(keyframes, { duration: total }).finished.then(
      () => {
        critter.busy = false;
        if (!fedUp) arrive(critter, 0);
      },
      () => (critter.busy = false),
    );
  };

  // A card moves by its offsets, never a transform: a transform would make it
  // a stacking context and pull the character hiding behind it to the front.
  const shake = (element) => {
    if (!element) return;
    const card = getComputedStyle(element).position === "relative";
    const step = (x, y) =>
      card ? { left: `${x}px`, top: `${y}px` } : { translate: `${x}px ${y}px` };
    element.animate(
      [step(0, 0), step(-5, 1), step(4, -1), step(-2, 0), step(0, 0)],
      { duration: 320, easing: "ease-out" },
    );
  };

  const yarn = (critter) => {
    const rect = critter.element.getBoundingClientRect();
    const ball = document.createElement("span");
    ball.className = "critter-yarn";
    ball.setAttribute("aria-hidden", "true");
    ball.style.left = `${rect.left + rect.width * 0.75 + scrollX}px`;
    ball.style.top = `${rect.top + rect.height * 0.3 + scrollY}px`;
    document.body.append(ball);
    ball
      .animate(
        [
          { translate: "0 0", rotate: "0deg", opacity: 1 },
          { translate: "26px -18px", rotate: "90deg", opacity: 1, offset: 0.2 },
          { translate: "60px 260px", rotate: "540deg", opacity: 0 },
        ],
        { duration: 1100, easing: "cubic-bezier(0.3, 0, 0.9, 0.6)" },
      )
      .finished.then(() => ball.remove());
  };

  // Every character arrives its own way. Transforms run on the inner body,
  // in the character's frame: positive y is back down where it came from.
  const PERSONALITY = {
    pixel: {
      emotion: EMOTION.content,
      frames: [
        { transform: "translateY(0)" },
        { transform: "translateY(-9%)", offset: 0.25 },
        { transform: "translateY(0)", offset: 0.5 },
        { transform: "translateY(-5%)", offset: 0.72 },
        { transform: "translateY(0)" },
      ],
      ms: 900,
    },
    guardian: {
      emotion: EMOTION.content,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(6deg)", offset: 0.45 },
        { transform: "rotate(0)" },
      ],
      ms: 1500,
    },
    sunny: {
      emotion: EMOTION.excited,
      frames: [
        { transform: "scale(1) rotate(0)" },
        { transform: "scale(1.1) rotate(-6deg)", offset: 0.3 },
        { transform: "scale(0.96) rotate(5deg)", offset: 0.6 },
        { transform: "scale(1) rotate(0)" },
      ],
      ms: 900,
    },
    chill: {
      emotion: EMOTION.tired,
      frames: [
        { transform: "scale(1)" },
        { transform: "scale(1.06, 0.92)", offset: 0.3 },
        { transform: "scale(0.97, 1.07)", offset: 0.6 },
        { transform: "scale(1)" },
      ],
      ms: 2200,
      easing: ease.soft,
    },
    nudge: {
      emotion: EMOTION.curious,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(-11deg)", offset: 0.18 },
        { transform: "rotate(0)", offset: 0.36 },
        { transform: "rotate(-11deg)", offset: 0.54 },
        { transform: "rotate(0)" },
      ],
      ms: 900,
    },
    fox: {
      emotion: EMOTION.curious,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(-7deg)", offset: 0.25 },
        { transform: "rotate(-7deg)", offset: 0.5 },
        { transform: "rotate(5deg)", offset: 0.75 },
        { transform: "rotate(0)" },
      ],
      ms: 1500,
      glance: [
        [-1, 0, 450],
        [1, 0, 450],
      ],
    },
    dog: {
      emotion: EMOTION.excited,
      frames: [0, 5, -5, 5, -5, 5, -5, 0].map((deg) => ({
        transform: `rotate(${deg}deg)`,
      })),
      ms: 900,
    },
    goat: {
      emotion: EMOTION.excited,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(-9deg) translateY(3%)", offset: 0.4 },
        { transform: "rotate(11deg) translateY(-4%)", offset: 0.52 },
        { transform: "rotate(0)" },
      ],
      ms: 1000,
      beat: 520,
      then: (critter) => shake(cover(critter)),
    },
    cow: {
      emotion: EMOTION.content,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(-3deg)", offset: 0.25 },
        { transform: "rotate(3deg)", offset: 0.75 },
        { transform: "rotate(0)" },
      ],
      ms: 2400,
      easing: ease.soft,
    },
    cat: {
      emotion: EMOTION.curious,
      frames: [
        { transform: "rotate(0)" },
        { transform: "rotate(-4deg)", offset: 0.35 },
        { transform: "rotate(9deg)", offset: 0.5 },
        { transform: "rotate(0)" },
      ],
      ms: 1100,
      beat: 550,
      then: yarn,
    },
    rabbit: {
      emotion: EMOTION.excited,
      frames: [
        { transform: "translateY(0) scale(1)" },
        { transform: "translateY(3%) scale(1.06, 0.92)", offset: 0.15 },
        { transform: "translateY(-24%) scale(0.96, 1.05)", offset: 0.45 },
        { transform: "translateY(0) scale(1.06, 0.92)", offset: 0.75 },
        { transform: "translateY(0) scale(1)" },
      ],
      ms: 1000,
    },
  };

  // The card or device a character hides behind is what the goat headbutts.
  const cover = (critter) => {
    const list = [...covers(critter)];
    if (list.length < 2) return list[0];
    const own = critter.element.getBoundingClientRect();
    const overlap = (rect) =>
      Math.max(
        0,
        Math.min(own.right, rect.right) - Math.max(own.left, rect.left),
      ) *
      Math.max(
        0,
        Math.min(own.bottom, rect.bottom) - Math.max(own.top, rect.top),
      );
    return list.sort(
      (a, b) =>
        overlap(b.getBoundingClientRect()) - overlap(a.getBoundingClientRect()),
    )[0];
  };

  const arrive = (critter, delay) => {
    if (still) return;
    const way = PERSONALITY[critter.name];
    if (!way) return;
    setTimeout(() => {
      if (critter.busy) return;
      critter.body.animate(way.frames, {
        duration: way.ms,
        easing: way.easing ?? "ease-in-out",
      });
      if (way.emotion) feel(critter, way.emotion, way.ms + 400);
      if (way.then) setTimeout(() => way.then(critter), way.beat ?? 0);
      if (way.glance) {
        let at = 300;
        for (const [x, y, ms] of way.glance) {
          setTimeout(() => glanceAt(critter, { x, y }), at);
          at += ms;
        }
        setTimeout(() => glanceAt(critter, null), at);
      }
    }, delay);
  };

  for (const critter of critters) {
    if (critter.hero) {
      critter.element.addEventListener("animationend", (event) => {
        if (
          event.target === critter.element &&
          event.animationName === "peek-in"
        )
          arrive(critter, 0);
      });
      continue;
    }
    if (critter.card) {
      critter.card.addEventListener("pointerenter", () => {
        if (still) return;
        set(critter, "boolean", "hovered", true);
        feel(critter, EMOTION.curious, 1600);
      });
      critter.card.addEventListener("pointerleave", () =>
        set(critter, "boolean", "hovered", false),
      );
    }
    if (critter.romp || critter.card) continue;
    // script.js marks a character is-peeking as its card arrives.
    new MutationObserver(() => {
      const out = critter.element.classList.contains("is-peeking");
      if (out === critter.out) return;
      critter.out = out;
      if (!out) return;
      arrive(critter, 520);
      // A phone has no room beside these characters: the line would cover
      // the copy or the card, so only a poke gets a bubble there.
      if (critter.line && !critter.said && innerWidth >= 700) {
        critter.said = true;
        setTimeout(() => say(critter, critter.line), 900);
      }
    }).observe(critter.element, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // A few of the flock ride along in the app wall and the closing flock
  // stands about: each bounces, looks around and at its neighbours, wiggles
  // and now and then celebrates.
  const rompers = critters.filter((critter) => critter.romp);
  const between = (low, high) => low + Math.random() * (high - low);

  const bounce = (critter, height = 14) =>
    critter.body.animate(
      [
        { transform: "translateY(0) scale(1)" },
        { transform: "translateY(2%) scale(1.06, 0.92)", offset: 0.12 },
        {
          transform: `translateY(-${height}%) scale(0.96, 1.05)`,
          offset: 0.5,
        },
        { transform: "translateY(0) scale(1.05, 0.94)", offset: 0.88 },
        { transform: "translateY(0) scale(1)" },
      ],
      { duration: 520, easing: "ease-in-out" },
    );
  const glances = (critter, steps) => {
    let at = 0;
    for (const [x, y, ms] of steps) {
      setTimeout(() => glanceAt(critter, { x, y }), at);
      at += ms;
    }
    setTimeout(() => glanceAt(critter, null), at);
    return at;
  };
  const centre = (critter) => {
    const rect = critter.element.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  };

  const ROMPS = [
    // A bounce, two or three.
    [
      4,
      (critter) => {
        const times = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < times; i++)
          setTimeout(() => bounce(critter, between(8, 16)), i * 540);
      },
    ],
    // Look around, or at the nearest neighbour on screen.
    [
      3,
      (critter) => {
        const [x, y] = centre(critter);
        let friend = null;
        let best = Infinity;
        for (const other of rompers) {
          if (other === critter || !other.visible) continue;
          const [ox, oy] = centre(other);
          const distance = Math.hypot(ox - x, oy - y);
          if (distance < best) [friend, best] = [other, distance];
        }
        if (friend && Math.random() < 0.5) {
          const [fx, fy] = centre(friend);
          const ms = glances(critter, [
            [
              Math.sign(fx - x) || 1,
              Math.max(-1, Math.min(1, (fy - y) / 200)),
              1500,
            ],
          ]);
          feel(critter, EMOTION.content, ms);
        } else
          glances(critter, [
            [-1, -0.2, 700],
            [1, -0.2, 700],
            [0, -0.7, 500],
          ]);
      },
    ],
    // Celebrate: the rig's own success, with a couple of little bounces.
    [
      2,
      (critter) => {
        set(critter, "number", "activity", 4);
        feel(critter, EMOTION.excited, 2600);
        setTimeout(() => set(critter, "number", "activity", 0), 2600);
        bounce(critter, 10);
        setTimeout(() => bounce(critter, 16), 600);
      },
    ],
    // Wiggle on the spot.
    [
      2,
      (critter) => {
        feel(critter, EMOTION.curious, 1200);
        critter.body.animate(
          [0, -6, 6, -6, 6, -3, 0].map((deg) => ({
            transform: `rotate(${deg}deg)`,
          })),
          { duration: 900, easing: "ease-in-out" },
        );
      },
    ],
  ];
  const romp = (critter) => {
    let roll = Math.random() * ROMPS.reduce((sum, [weight]) => sum + weight, 0);
    for (const [weight, act] of ROMPS) {
      roll -= weight;
      if (roll <= 0) return act(critter);
    }
  };
  // Poked, a romper jumps out of its skin.
  const startle = (critter) => {
    critter.busy = true;
    feel(critter, SURPRISED, 1800);
    bounce(critter, 34);
    setTimeout(() => bounce(critter, 10), 560);
    setTimeout(() => (critter.busy = false), 1200);
  };
  if (!still) {
    for (const critter of rompers) {
      const play = () => {
        if (
          critter.visible &&
          !critter.busy &&
          document.visibilityState === "visible"
        )
          romp(critter);
        setTimeout(play, between(1800, 4600));
      };
      setTimeout(play, between(300, 2600));
    }
  }

  // Pointer: eyes follow it, hovering greets, a click or tap pokes.
  let pointer = null;
  let over = null;
  let ticking = false;
  const tick = () => {
    ticking = false;
    let moving = false;
    for (const critter of critters) {
      if (!critter.rig || !critter.visible) continue;
      let tx = 0;
      let ty = 0;
      if (critter.glance) {
        tx = critter.glance.x;
        ty = critter.glance.y;
      } else if (pointer && !still) {
        const f = frame(critter);
        const [lx, ly] = f.local(
          pointer.x - f.cx,
          pointer.y - f.cy + f.rect.height * 0.08,
        );
        const distance = Math.hypot(lx, ly) || 1;
        const reach = Math.min(1, distance / (f.height * 1.6));
        tx = (lx / distance) * reach;
        ty = (ly / distance) * reach;
      }
      const look = critter.look;
      look.x += (tx - look.x) * 0.18;
      look.y += (ty - look.y) * 0.18;
      if (Math.abs(tx - look.x) + Math.abs(ty - look.y) > 0.01) moving = true;
      set(critter, "number", "lookX", look.x);
      set(critter, "number", "lookY", look.y);
    }
    if (moving || critters.some((critter) => critter.glance)) schedule();
  };
  const schedule = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(tick);
  };

  const interactive = (target) =>
    target instanceof Element && target.closest("a, button, input, label");

  addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      pointer = { x: event.clientX, y: event.clientY };
      const critter = interactive(event.target)
        ? null
        : critterAt(event.clientX, event.clientY);
      if (critter !== over) {
        if (over) set(over, "boolean", "hovered", false);
        if (critter && !still) set(critter, "boolean", "hovered", true);
        over = critter;
        document.documentElement.classList.toggle("is-over-critter", !!critter);
      }
      schedule();
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => {
    pointer = null;
    schedule();
  });
  addEventListener("scroll", schedule, { passive: true });
  addEventListener(
    "pointerdown",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    },
    { passive: true },
  );
  addEventListener("click", (event) => {
    if (interactive(event.target)) return;
    const critter = critterAt(event.clientX, event.clientY);
    if (critter) poke(critter);
  });

  // Rive arrives after the page has settled, and each rig only once its
  // character first scrolls into view.
  const files = new Map();
  const riv = (name) => {
    if (!files.has(name))
      files.set(
        name,
        fetch(`/assets/characters/${name}.riv`).then((response) => {
          if (!response.ok) throw new Error(`No rig for ${name}`);
          return response.arrayBuffer();
        }),
      );
    return files.get(name);
  };

  let runtime = null;
  const loadRuntime = () =>
    (runtime ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/rive/rive.js";
      script.onload = () => {
        window.rive.RuntimeLoader.setWasmUrl("/vendor/rive/rive.wasm");
        window.rive.RuntimeLoader.setWasmFallbackUrl(null);
        resolve(window.rive);
      };
      script.onerror = reject;
      document.head.append(script);
    }));

  const rig = async (critter) => {
    if (critter.rig !== null) return;
    critter.rig = false;
    try {
      const [rive, buffer] = await Promise.all([
        loadRuntime(),
        riv(critter.name),
      ]);
      const f = frame(critter);
      if (!f.height) {
        critter.rig = null;
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.className = "critter-rig";
      const density = Math.max(
        0.3,
        f.scale * Math.min(2, devicePixelRatio || 1) * (f.height / 615),
      );
      // The PNG sits at (92, 100) on the rig's 640 × 760 artboard, which
      // leaves room for ears, hops and the ground shadow (see .critter-rig).
      canvas.width = Math.round(640 * density);
      canvas.height = Math.round(760 * density);
      const title = critter.name[0].toUpperCase() + critter.name.slice(1);
      const instance = new rive.Rive({
        buffer: buffer.slice(0),
        canvas,
        artboard: title,
        stateMachine: title,
        autoplay: true,
        autoBind: true,
        shouldDisableRiveListeners: true,
        layout: new rive.Layout({
          fit: rive.Fit.Contain,
          alignment: rive.Alignment.Center,
        }),
        onLoad: () => {
          critter.rig = instance;
          set(critter, "boolean", "reducedMotion", still);
          // Every rig loads at once, so each starts somewhere different in
          // its eight-second ambient loop or the whole flock blinks together.
          if (!still && typeof instance.advanceAndReportChanges === "function")
            for (let t = Math.random() * 8; t > 0; t -= 0.25)
              instance.advanceAndReportChanges(Math.min(0.25, t));
          if (!critter.visible) instance.stopRendering();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              critter.element.classList.add("is-live"),
            ),
          );
          schedule();
        },
        onLoadError: () => canvas.remove(),
      });
      critter.body.append(canvas);
    } catch {
      // The PNG stays.
    }
  };

  let started = false;
  const ready =
    "IntersectionObserver" in window && !navigator.connection?.saveData;
  const sight = ready
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const critter = critters.find((c) => c.element === entry.target);
            if (!critter) continue;
            critter.visible = entry.isIntersecting;
            if (critter.rig) {
              if (critter.visible) critter.rig.startRendering();
              else critter.rig.stopRendering();
            } else if (critter.visible && started) rig(critter);
          }
        },
        { rootMargin: "120px 0px" },
      )
    : null;
  const start = () => {
    started = true;
    for (const critter of critters) if (critter.visible) rig(critter);
  };
  if (sight) {
    for (const critter of critters) sight.observe(critter.element);
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 600));
    if (document.readyState === "complete") idle(start);
    else addEventListener("load", () => idle(start), { once: true });
  }
})();
