const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector("#site-nav");

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  navigation?.classList.toggle("open", open);
});

navigation?.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return;
  menuButton?.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
});

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());

// The hero's characters sink behind the devices as the page scrolls away.
const heroStage = document.querySelector(".hero-stage");
if (heroStage instanceof HTMLElement) {
  let queued = false;
  const sink = () => {
    queued = false;
    const distance = window.innerWidth < 700 ? 260 : 420;
    heroStage.style.setProperty(
      "--p",
      String(Math.min(1, window.scrollY / distance)),
    );
  };
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(sink);
    },
    { passive: true },
  );
  sink();
}

// Further down, each character pops out while the card or edge it hides
// behind is on screen. On a phone a section runs several screens tall, so
// the section alone would send a character out long before anyone sees it.
if ("IntersectionObserver" in window) {
  const zones = document.querySelectorAll("[data-peek-zone]");
  if (zones.length) {
    document.documentElement.classList.add("js-peek");
    const peekers = new Map();
    const watch = (host, element) => {
      const list = peekers.get(host) ?? [];
      list.push(element);
      peekers.set(host, list);
    };
    for (const zone of zones) {
      watch(zone, zone);
      for (const character of zone.querySelectorAll(".follow")) {
        if (character.parentElement) watch(character.parentElement, character);
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const element of peekers.get(entry.target) ?? []) {
            element.classList.toggle("is-peeking", entry.isIntersecting);
          }
        }
      },
      { rootMargin: "0px 0px -30% 0px" },
    );
    for (const host of peekers.keys()) observer.observe(host);
  }
}

const yoursTrack = document.querySelector(".yours-track");
const yoursTabs = [...document.querySelectorAll(".yours-tab")];

const showYours = (index) => {
  yoursTabs.forEach((tab, i) =>
    tab.setAttribute("aria-pressed", String(i === index)),
  );
};

yoursTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => {
    const slide = document.getElementById(
      tab.getAttribute("aria-controls") ?? "",
    );
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    slide?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "nearest",
      inline: "start",
    });
    showYours(index);
  });
});

yoursTrack?.addEventListener("scrollend", () => {
  if (!(yoursTrack instanceof HTMLElement)) return;
  showYours(Math.round(yoursTrack.scrollLeft / yoursTrack.clientWidth));
});
