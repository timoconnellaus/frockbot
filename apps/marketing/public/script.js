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

// Further down, each section's characters pop out while it is on screen.
if ("IntersectionObserver" in window) {
  const zones = document.querySelectorAll("[data-peek-zone]");
  if (zones.length) {
    document.documentElement.classList.add("js-peek");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle("is-peeking", entry.isIntersecting);
        }
      },
      { rootMargin: "0px 0px -30% 0px" },
    );
    for (const zone of zones) observer.observe(zone);
  }
}
