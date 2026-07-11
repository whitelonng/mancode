const searchInput = document.querySelector("[data-doc-search]");
const searchSections = [...document.querySelectorAll("[data-searchable]")];
const emptyState = document.querySelector("[data-search-empty]");

function filterDocumentation(query) {
  const term = query.trim().toLowerCase();
  let matchCount = 0;

  for (const section of searchSections) {
    const matches = !term || section.textContent.toLowerCase().includes(term);
    section.hidden = !matches;
    if (matches) matchCount += 1;
  }

  emptyState?.classList.toggle("visible", Boolean(term) && matchCount === 0);
}

searchInput?.addEventListener("input", (event) => filterDocumentation(event.target.value));

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput?.focus();
  }
});
