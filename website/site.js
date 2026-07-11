const copyButtons = document.querySelectorAll("[data-copy]");

const themeToggle = document.querySelector("[data-theme-toggle]");

function updateThemeToggle(theme) {
  if (!themeToggle) return;
  const isLight = theme === "light";
  const isChinese = document.documentElement.lang.startsWith("zh");
  const label = isChinese
    ? isLight
      ? "切换到深色主题"
      : "切换到白色主题"
    : isLight
      ? "Switch to dark theme"
      : "Switch to light theme";
  themeToggle.setAttribute(
    "aria-label",
    label,
  );
  themeToggle.title = label;
  themeToggle.querySelector("span").textContent = isLight ? "◑" : "◐";
}

updateThemeToggle(document.documentElement.dataset.theme || "dark");

themeToggle?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  updateThemeToggle(nextTheme);

  try {
    localStorage.setItem("mancode-theme", nextTheme);
  } catch {}
});

async function copyText(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const originalLabel = button.textContent;

    try {
      await copyText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Retry";
    }

    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1400);
  });
}

const modeTabs = [...document.querySelectorAll("[data-mode]")];
const modePanels = [...document.querySelectorAll("[data-panel]")];

function selectMode(mode) {
  for (const tab of modeTabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  }

  for (const panel of modePanels) {
    panel.classList.toggle("active", panel.dataset.panel === mode);
  }
}

for (const [index, tab] of modeTabs.entries()) {
  tab.addEventListener("click", () => selectMode(tab.dataset.mode));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + modeTabs.length) % modeTabs.length;
    modeTabs[nextIndex].focus();
    selectMode(modeTabs[nextIndex].dataset.mode);
  });
}

const revealItems = document.querySelectorAll(".reveal");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8%", threshold: 0.08 },
  );

  for (const item of revealItems) observer.observe(item);
} else {
  for (const item of revealItems) item.classList.add("visible");
}
