// Responsive dashboard shell (admin / teacher / student pages only — NOT the quiz page).
//  * Phones & tablets: a top bar with a ☰ button; the sidebar slides in as a drawer.
//  * Phones: every table is shown as a stack of cards. Each cell gets a data-label
//    (taken from its column header) so CSS can print "Roll No.  JIIT4" etc.
//  * Every table gets a horizontal-scroll wrapper so wide tables never break the page.
(function () {
  const shell = document.querySelector('.app-shell');
  const sidebar = shell && shell.querySelector('.sidebar');
  if (!sidebar) return;

  // ---- top bar + drawer ----
  const bar = document.createElement('header');
  bar.className = 'mobile-bar';
  bar.innerHTML = '<button class="menu-btn" type="button" aria-label="Open menu">☰</button>' +
    '<div class="mobile-title"></div><img class="mobile-logo" src="img/logo.png" alt="" />';
  shell.prepend(bar);
  const scrim = document.createElement('div');
  scrim.className = 'sidebar-scrim';
  shell.appendChild(scrim);

  const setOpen = (open) => document.body.classList.toggle('nav-open', open);
  bar.querySelector('.menu-btn').addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
  scrim.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  const title = bar.querySelector('.mobile-title');
  const updateTitle = () => {
    const active = sidebar.querySelector('.nav-btn.active');
    title.textContent = active ? active.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim() : 'Classroom';
  };
  sidebar.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.addEventListener('click', () => {
    setOpen(false);
    setTimeout(updateTitle, 0);
    window.scrollTo({ top: 0 });
  }));
  updateTitle();

  // ---- tables ----
  const main = document.querySelector('.main');
  function prepareTables() {
    if (!main) return;
    main.querySelectorAll('table').forEach((table) => {
      const parent = table.parentElement;
      if (!parent.classList.contains('table-wrap') && !parent.classList.contains('table-scroll')) {
        const wrap = document.createElement('div');
        wrap.className = 'table-scroll';
        // keep any spacing that was put on the table itself
        if (table.style.marginTop) { wrap.style.marginTop = table.style.marginTop; table.style.marginTop = '0'; }
        parent.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
      // only visible headers count (some columns are hidden for some users)
      const heads = [...table.querySelectorAll('thead th')]
        .filter((th) => getComputedStyle(th).display !== 'none')
        .map((th) => th.textContent.trim());
      table.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          const label = td.hasAttribute('colspan') ? '' : (heads[i] || '');
          if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        });
      });
    });
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; prepareTables(); updateTitle(); });
  };
  if (main) new MutationObserver(queue).observe(main, { childList: true, subtree: true });
  prepareTables();
})();
