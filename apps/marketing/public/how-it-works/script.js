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

for (const example of document.querySelectorAll(".code-example")) {
  const heading = example.querySelector(".code-heading");
  const code = example.querySelector("pre code");
  if (!heading || !code) continue;
  const status = document.createElement("span");
  status.className = "code-copy-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const button = document.createElement("button");
  button.className = "code-copy";
  button.type = "button";
  button.textContent = "Copy code";
  button.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(code.textContent ?? "");
      status.textContent = "Copied.";
    } catch {
      status.textContent = "Copy failed. Select the code and copy it manually.";
    }
  });
  heading.append(status, button);
}
