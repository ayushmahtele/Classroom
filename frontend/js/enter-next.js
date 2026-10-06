// Enter key on forms marked with data-enter-next:
// Enter in a box moves to the next box; Enter in the last box submits
// (presses the form's main button). The 6-digit code boxes are left alone —
// Enter there verifies the code straight away.
(function () {
  const fieldSel = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), select:not([disabled])';
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
    const form = el.closest('form[data-enter-next]');
    if (!form || el.closest('.otp')) return;
    const fields = [...form.querySelectorAll(fieldSel)].filter(visible);
    const i = fields.indexOf(el);
    if (i === -1) return;
    e.preventDefault();
    if (i < fields.length - 1) {
      const next = fields[i + 1];
      next.focus();
      if (typeof next.select === 'function' && next.value) next.select();
    } else {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.querySelector('[type=submit]')?.click();
    }
  });
})();
