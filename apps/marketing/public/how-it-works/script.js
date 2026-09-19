const contents = document.querySelector(".inside-contents details");
const compactContents = window.matchMedia("(max-width: 860px)");
if (contents) {
  contents.open = !compactContents.matches;
  compactContents.addEventListener("change", (event) => {
    contents.open = !event.matches;
  });
  contents.addEventListener("click", (event) => {
    if (event.target.closest("a") && compactContents.matches)
      contents.open = false;
  });
}

const sectionLinks = [...document.querySelectorAll(".inside-contents nav a")];
if ("IntersectionObserver" in window) {
  const visibleSections = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        visibleSections.set(entry.target.id, entry.isIntersecting);
      const current = sectionLinks.find((link) =>
        visibleSections.get(link.hash.slice(1)),
      );
      if (!current) return;
      for (const link of sectionLinks) {
        if (link === current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    },
    { rootMargin: "-15% 0px -55% 0px" },
  );
  for (const link of sectionLinks) {
    const section = document.querySelector(link.hash);
    if (section) observer.observe(section);
  }
}
