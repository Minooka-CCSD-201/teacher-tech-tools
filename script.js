const searchInput = document.getElementById("resource-search");
const resourceCards = Array.from(document.querySelectorAll(".resource-card"));
const resourceTabs = Array.from(document.querySelectorAll(".resource-tab"));
const visibleCount = document.getElementById("visible-count");
const emptyState = document.getElementById("empty-state");
const emptyStateTitle = document.getElementById("empty-state-title");
const emptyStateCopy = document.getElementById("empty-state-copy");
let activeSource = "crafted";

function filterResources() {
  const query = searchInput.value.trim().toLowerCase();
  let matches = 0;

  resourceCards.forEach((card) => {
    const searchableText = `${card.textContent} ${card.dataset.search}`.toLowerCase();
    const isMatch = card.dataset.source === activeSource && searchableText.includes(query);

    card.hidden = !isMatch;
    if (isMatch) matches += 1;
  });

  visibleCount.textContent = matches;
  emptyState.hidden = matches !== 0;

  if (matches === 0 && activeSource === "external" && query === "") {
    emptyStateTitle.textContent = "No external resources yet";
    emptyStateCopy.textContent = "Approved third-party resources will appear here.";
  } else {
    emptyStateTitle.textContent = "No resources found";
    emptyStateCopy.textContent = "Try a different subject or keyword.";
  }
}

searchInput.addEventListener("input", filterResources);

resourceTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activeSource = tab.dataset.source;

    resourceTabs.forEach((candidate) => {
      const isActive = candidate === tab;
      candidate.classList.toggle("is-active", isActive);
      candidate.setAttribute("aria-selected", isActive);
    });

    searchInput.value = "";
    filterResources();
  });
});

document.getElementById("current-year").textContent = new Date().getFullYear();
