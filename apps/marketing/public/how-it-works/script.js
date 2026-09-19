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
