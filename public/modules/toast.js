const toastEl = document.createElement("div");
toastEl.className = "playback-toast";
toastEl.setAttribute("role", "status");
toastEl.setAttribute("aria-live", "polite");
document.body.appendChild(toastEl);

let toastTimer = null;

export function showToast(message, durationMs = 4000) {
  const duration = Number.isFinite(Number(durationMs))
    ? Math.max(1000, Math.min(30_000, Number(durationMs)))
    : 4000;

  toastEl.textContent = String(message || "Action completed.");
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), duration);
}
