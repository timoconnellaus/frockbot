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

const architectureHost = document.querySelector("[data-architecture-diagram]");
if (architectureHost) {
  fetch("/open/")
    .then((response) => {
      if (!response.ok) throw new Error("The system map could not be loaded");
      return response.text();
    })
    .then((html) => {
      const documentFromOpenPage = new DOMParser().parseFromString(
        html,
        "text/html",
      );
      const diagram = documentFromOpenPage.querySelector(".open-figure");
      if (!diagram) throw new Error("The system map is missing");
      diagram.classList.add("inside-architecture-figure");
      const caption = diagram.querySelector("#arch-caption");
      if (caption) caption.id = "inside-architecture-caption";
      diagram.setAttribute("aria-labelledby", "inside-architecture-caption");
      diagram
        .querySelector("svg")
        ?.setAttribute("aria-labelledby", "inside-architecture-caption");
      architectureHost.replaceChildren(diagram);
    })
    .catch(() => {
      const link = document.createElement("a");
      link.className = "inside-text-link";
      link.href = "/open/#shape";
      link.textContent = "Explore the full system map →";
      architectureHost.replaceChildren(link);
    });
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
