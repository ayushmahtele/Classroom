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

    const college = p.collegeName ? `${p.collegeName}${p.collegeShort ? ` (${p.collegeShort})` : ''}` : '-';
    const rows = role === 'teacher'
      ? [['Teacher ID', p.teacherId], ['Teacher name', p.name], ['Email', p.email], ['College', college], ['Domain', domain], ['Total classes', p.totalClasses]]
      : [['Student ID', p.studentId], ['Student name', p.name], ['Email', p.email], ['College', college], ['Roll number', p.rollNumber || '-'], ['Domain', domain], ['Total classes', p.totalClasses]];

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

      <div class="panel" id="pwPanel"></div>`;

    // Change password, or reset it with a code sent to the account email
    renderPasswordPanel(document.getElementById('pwPanel'), { email: p.email });
  } catch (err) {
    box.innerHTML = `<p class="error-msg">${pfEsc(err.message)}</p>`;
  }
}
