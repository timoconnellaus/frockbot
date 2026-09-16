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

const heroFlock = document.querySelector(".hero-flock");
let heroVisible = true;

const updateHeroMotion = () => {
  if (!(heroFlock instanceof SVGSVGElement)) return;
  heroFlock.classList.toggle("paused", document.hidden || !heroVisible);
};

updateHeroMotion();
document.addEventListener("visibilitychange", updateHeroMotion);

if (heroFlock && "IntersectionObserver" in window) {
  new IntersectionObserver(
    ([entry]) => {
      heroVisible = entry?.isIntersecting ?? false;
      updateHeroMotion();
    },
    { rootMargin: "100px 0px" },
  ).observe(heroFlock);
}
