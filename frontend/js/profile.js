// Shared "My Profile" page for teachers and students.
// Needs js/api.js and an element with id="profileBox" on the page.
function pfEsc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadProfile(role) {
  const box = document.getElementById('profileBox');
  box.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
  try {
    const p = await api(role === 'teacher' ? '/teacher/me' : '/student/profile');
    const domain = role === 'teacher'
      ? (p.departments.length ? p.departments.join(', ') : '-')
      : (p.department || '-');

    const rows = role === 'teacher'
      ? [['Teacher ID', p.teacherId], ['Teacher name', p.name], ['Email', p.email], ['Domain', domain], ['Total classes', p.totalClasses]]
      : [['Student ID', p.studentId], ['Student name', p.name], ['Email', p.email], ['Roll number', p.rollNumber || '-'], ['Domain', domain], ['Total classes', p.totalClasses]];

    const classList = p.classes.length
      ? `<ul style="margin:6px 0 0;padding-left:20px;font-size:14px">${p.classes.map((c) => role === 'teacher'
          ? `<li>${pfEsc(c.name)} <span style="color:var(--muted)">— ${c.studentCount} student(s)</span></li>`
          : `<li>${pfEsc(c.name)}${c.teacherName ? ` <span style="color:var(--muted)">— ${pfEsc(c.teacherName)}</span>` : ''}</li>`).join('')}</ul>`
      : '<p style="color:var(--muted);font-size:14px;margin:6px 0 0">No classes yet.</p>';

    box.innerHTML = `
      <div class="panel">
        <h3 style="margin-top:0">My Information</h3>
        <table>
          <tbody>${rows.map(([k, v]) => `<tr><td style="width:180px;color:var(--muted)">${k}</td><td><b>${pfEsc(v)}</b></td></tr>`).join('')}</tbody>
        </table>
        <h4 style="margin-bottom:0">Classes (${p.totalClasses})</h4>
        ${classList}
      </div>

      <div class="panel">
        <h3 style="margin-top:0">Password</h3>
        <form id="pwForm" style="max-width:360px">
          <label>Current password</label><input id="pwCurrent" type="password" required />
          <label>New password</label><input id="pwNew" type="password" minlength="6" required />
          <label>Confirm new password</label><input id="pwConfirm" type="password" minlength="6" required />
          <div class="row" style="margin-top:14px"><button class="btn" type="submit">Change password</button></div>
          <div class="error-msg" id="pwMsg"></div>
        </form>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0" />
        <p style="font-size:13px;color:var(--muted);margin:0 0 10px">
          Forgot your current password? Send a reset request to your ${role === 'teacher' ? 'admin' : 'teacher/admin'}.
          They will give you a new temporary password.
        </p>
        <button class="btn secondary" type="button" id="pwForgotBtn">Forgot password — request reset</button>
        <div id="pwForgotMsg" style="font-size:13px;margin-top:8px"></div>
      </div>`;

    document.getElementById('pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('pwMsg');
      msg.style.color = '';
      msg.textContent = '';
      const cur = document.getElementById('pwCurrent').value;
      const nw = document.getElementById('pwNew').value;
      if (nw !== document.getElementById('pwConfirm').value) { msg.textContent = 'New passwords do not match.'; return; }
      try {
        await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
        e.target.reset();
        msg.style.color = 'var(--ok)';
        msg.textContent = 'Password changed.';
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    document.getElementById('pwForgotBtn').addEventListener('click', async () => {
      const out = document.getElementById('pwForgotMsg');
      try {
        await api('/auth/request-reset', { method: 'POST' });
        out.style.color = 'green';
        out.textContent = `Reset request sent to your ${role === 'teacher' ? 'admin' : 'teacher/admin'}. Ask them for your new temporary password.`;
      } catch (err) {
        out.style.color = '';
        out.textContent = err.message;
      }
    });
  } catch (err) {
    box.innerHTML = `<p class="error-msg">${pfEsc(err.message)}</p>`;
  }
}
