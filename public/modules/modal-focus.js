export function trapModalFocus(container, { onClose, initialFocus } = {}) {
  const previousFocus = document.activeElement;
  const focusables = () => [...container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )];
  const onKeydown = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener("keydown", onKeydown);
  requestAnimationFrame(() => (initialFocus || focusables()[0])?.focus());
  return () => {
    container.removeEventListener("keydown", onKeydown);
    previousFocus?.focus?.();
  };
}
