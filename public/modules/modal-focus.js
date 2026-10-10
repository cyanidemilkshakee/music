export function trapModalFocus(container, { onClose, initialFocus } = {}) {
  const previousFocus = document.activeElement, inerted = [];
  let branch = container;
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children || []) {
      if (sibling !== branch) { inerted.push([sibling, sibling.inert]); sibling.inert = true; }
    }
    branch = branch.parentElement;
  }
  const focusables = () => [...container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]'));
  const onKeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose?.(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables(), first = items[0], last = items.at(-1);
    if (!first) { event.preventDefault(); container.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKeydown);
  let released = false;
  requestAnimationFrame(() => { if (!released) (initialFocus || focusables()[0])?.focus(); });
  return () => {
    if (released) return; released = true;
    container.removeEventListener('keydown', onKeydown);
    for (const [element, wasInert] of inerted) element.inert = wasInert;
    requestAnimationFrame(() => { if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus(); });
  };
}
