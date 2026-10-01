// frockbot.com/deploy: previews the install's address as its name is typed,
// and keeps the Deploying page current. Every page works without this.
(() => {
  const input = document.querySelector("input[data-subdomain]");
  const address = document.getElementById("deploy-address");
  if (input && address) {
    const subdomain = input.getAttribute("data-subdomain");
    input.addEventListener("input", () => {
      const name =
        input.value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^[^a-z]+/, "")
          .slice(0, 40)
          .replace(/-+$/, "") || "your-name";
      address.textContent = `https://${name}.${subdomain}.workers.dev`;
    });
  }

  if (document.body.dataset.live !== "true") return;
  const refresh = async () => {
    try {
      const response = await fetch(location.pathname, {
        headers: { accept: "text/html" },
        cache: "no-store",
      });
      if (response.redirected) {
        location.assign(response.url);
        return;
      }
      const next = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const main = next.getElementById("deploy-main");
      const current = document.getElementById("deploy-main");
      if (main && current) current.replaceChildren(...main.childNodes);
      if (next.body.dataset.live !== "true") return;
    } catch {
      // A dropped connection is retried on the next tick.
    }
    setTimeout(refresh, 3000);
  };
  setTimeout(refresh, 3000);
})();
