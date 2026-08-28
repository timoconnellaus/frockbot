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
