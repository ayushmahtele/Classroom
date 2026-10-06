// "My Info" section for college admins (admin.html).
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
      const statusBadge = `<span class="badge ${c.status === 'active' ? 'ok' : 'danger'}">${esc(c.status)}</span>`;

      box.innerHTML = `
        <div class="info-grid">
          <div class="panel">
            <h3 style="margin-top:0">My information</h3>
            <table class="info-table"><tbody>${rowsHtml([
              ['Admin ID', `<code>${esc(p.adminId)}</code>`],
              ['Name', esc(p.name)],
              ['Email', esc(p.email)],
              ['Role', 'College admin'],
              ['Account created', esc(day(p.createdAt))]
            ])}</tbody></table>
            <p class="hint" style="margin-top:12px">Sign in from the <b>Admin</b> tab with your Admin ID or your email.</p>
          </div>

          <div class="panel">
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
          </div>
        </div>

        <div class="panel">
          <h3 style="margin-top:0">Password</h3>
          <form id="infoPwForm" class="info-pw">
            <label>Current password</label><input id="infoPwCurrent" type="password" autocomplete="current-password" required />
            <label>New password</label><input id="infoPwNew" type="password" minlength="6" autocomplete="new-password" required />
            <label>Confirm new password</label><input id="infoPwConfirm" type="password" minlength="6" autocomplete="new-password" required />
            <div class="row" style="margin-top:14px"><button class="btn" type="submit">Change password</button></div>
            <div class="error-msg" id="infoPwMsg"></div>
          </form>
          <p class="hint" style="margin-top:6px">Forgot your current password? Log out and use <b>Forgot password?</b> on the sign-in page —
            a 6-digit code will be sent to <b>${esc(p.email)}</b>.</p>
        </div>`;

      document.getElementById('infoPwForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('infoPwMsg');
        msg.style.color = '';
        msg.textContent = '';
        const cur = document.getElementById('infoPwCurrent').value;
        const nw = document.getElementById('infoPwNew').value;
        if (nw.length < 6) { msg.textContent = 'New password must be at least 6 characters.'; return; }
        if (nw !== document.getElementById('infoPwConfirm').value) { msg.textContent = 'New passwords do not match.'; return; }
        try {
          await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
          e.target.reset();
          msg.style.color = 'var(--ok)';
          msg.textContent = 'Password changed.';
        } catch (err) {
          msg.textContent = err.message;
        }
      });
    } catch (err) {
      box.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
    }
  }
})();
