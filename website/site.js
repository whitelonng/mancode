const copyButtons = document.querySelectorAll("[data-copy], [data-copy-code]");
const copyStatus = document.querySelector("[data-copy-status]");

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
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
  themeToggle.querySelector("span").textContent = isLight ? "◑" : "◐";
}

updateThemeToggle(document.documentElement.dataset.theme || "dark");

themeToggle?.addEventListener("click", () => {
  const nextTheme =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  updateThemeToggle(nextTheme);

  try {
    localStorage.setItem("mancode-theme", nextTheme);
  } catch {}
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy command was rejected");
}

function getCopyText(button) {
  if (button.hasAttribute("data-copy")) {
    return button.dataset.copy.replace(/\\n/g, "\n");
  }

  const code = button.closest(".code-wrap")?.querySelector("pre code");
  if (!code) return "";

  const clone = code.cloneNode(true);
  const prompts = [...clone.querySelectorAll(".command-prompt")];
  for (const prompt of prompts) prompt.remove();

  let text = clone.textContent;
  if (prompts.length > 0) {
    text = text
      .split("\n")
      .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  return text.trim();
}

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const originalLabel = button.textContent;
    const isChinese = document.documentElement.lang.startsWith("zh");
    const text = getCopyText(button);

    try {
      if (!text) throw new Error("No code to copy");
      await copyText(text);
      button.textContent = isChinese ? "已复制" : "Copied";
      if (copyStatus) {
        copyStatus.textContent = isChinese
          ? "代码已复制到剪贴板。"
          : "Code copied to the clipboard.";
      }
    } catch {
      button.textContent = isChinese ? "重试" : "Retry";
      if (copyStatus) {
        copyStatus.textContent = isChinese
          ? "复制失败，请重试。"
          : "Copy failed. Please retry.";
      }
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
