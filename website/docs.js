const searchInput = document.querySelector("[data-doc-search]");
const searchSections = [...document.querySelectorAll("[data-searchable]")];
const emptyState = document.querySelector("[data-search-empty]");
const searchStatus = document.querySelector("[data-search-status]");
const searchShortcut = document.querySelector("[data-search-shortcut]");
const sectionLinks = [
  ...document.querySelectorAll(
    '.docs-nav a[href^="#"], .docs-toc a[href^="#"]',
  ),
];
const navGroups = [...document.querySelectorAll(".docs-nav-group")];
const isChinese = document.documentElement.lang.startsWith("zh");

if (searchShortcut) {
  const isApplePlatform = /Mac|iPhone|iPad|iPod/.test(
    navigator.platform || navigator.userAgent,
  );
  searchShortcut.textContent = isApplePlatform ? "⌘K" : "Ctrl K";
}

function filterDocumentation(query) {
  const term = query.trim().toLowerCase();
  let matchCount = 0;

  for (const section of searchSections) {
    const matches =
      !term || section.textContent.toLocaleLowerCase().includes(term);
    section.hidden = !matches;
    if (matches) matchCount += 1;
  }

  for (const link of sectionLinks) {
    const section = document.querySelector(link.getAttribute("href"));
    link.hidden = Boolean(term) && Boolean(section?.hidden);
  }

  for (const group of navGroups) {
    const controlledLinks = [...group.querySelectorAll('a[href^="#"]')];
    if (controlledLinks.length === 0) continue;
    group.hidden =
      Boolean(term) && controlledLinks.every((link) => link.hidden);
  }

  emptyState?.classList.toggle("visible", Boolean(term) && matchCount === 0);
  if (searchStatus) {
    searchStatus.textContent = term
      ? isChinese
        ? `找到 ${matchCount} 个章节`
        : `${matchCount} section${matchCount === 1 ? "" : "s"} found`
      : "";
  }
}

searchInput?.addEventListener("input", (event) =>
  filterDocumentation(event.target.value),
);

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput?.focus();
  }

  if (event.key === "Escape" && document.activeElement === searchInput) {
    searchInput.value = "";
    filterDocumentation("");
    searchInput.blur();
  }
});
