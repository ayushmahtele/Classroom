// "My Profile" section for college admins and the global admin (admin.html).
// Kept in its own file so nothing inside admin.js had to change.
(function () {
  const btn = document.querySelector('.nav-btn[data-view="info"]');
  if (!btn) return;
  // admin.js already switches the visible section; this only fills it in.
  btn.addEventListener('click', loadMyInfo);

  const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
  const rowsHtml = (rows) => rows.map(([k, v]) => `<tr><td class="info-key">${k}</td><td><b>${v}</b></td></tr>`).join('');

  async function loadMyInfo() {
    const box = document.getElementById('infoBox');
    box.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
    try {
      const p = await api('/admin/my-info');
      const c = p.college;
      const s = p.stats || {};
      const statusBadge = c ? `<span class="badge ${c.status === 'active' ? 'ok' : 'danger'}">${esc(c.status)}</span>` : '';

      box.innerHTML = `
        <div class="info-grid">
          <div class="panel">
            <h3 style="margin-top:0">My information</h3>
            <table class="info-table"><tbody>${rowsHtml([
              ['Admin ID', `<code>${esc(p.adminId)}</code>`],
              ['Name', esc(p.name)],
              ['Email', esc(p.email)],
              ['Role', p.isGlobal ? 'Global (platform) admin' : 'College admin'],
              ['Account created', esc(day(p.createdAt))]
            ])}</tbody></table>
            <p class="hint" style="margin-top:12px">Sign in from the <b>Admin</b> tab with your Admin ID or your email.</p>
          </div>

          ${c ? `<div class="panel">
            <h3 style="margin-top:0">My college</h3>
            <table class="info-table"><tbody>${rowsHtml([
              ['College', esc(c.name)],
              ['Short name', esc(c.shortName)],
              ['Status', statusBadge],
              ['Next roll no.', esc(c.nextRollNumber)],
              ['Added on', esc(day(c.createdAt))],
              ['Teachers', esc(s.teachers ?? 0)],
              ['Students', esc(s.students ?? 0)],
              ['Classes', esc(s.classes ?? 0)],
              ['Quizzes', esc(s.quizzes ?? 0)]
            ])}</tbody></table>
          </div>` : `<div class="panel">
            <h3 style="margin-top:0">Platform</h3>
            <table class="info-table"><tbody>${rowsHtml([
              ['Colleges', esc(s.colleges ?? 0)],
              ['Teachers', esc(s.teachers ?? 0)],
              ['Students', esc(s.students ?? 0)],
              ['Classes', esc(s.classes ?? 0)],
              ['Quizzes', esc(s.quizzes ?? 0)]
            ])}</tbody></table>
          </div>`}
        </div>

        <div class="panel" id="infoPwPanel"></div>`;

      // Reset password (new + confirm only)
      renderPasswordPanel(document.getElementById('infoPwPanel'));
    } catch (err) {
      box.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
    }
  }
})();
