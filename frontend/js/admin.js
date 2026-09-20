const me = Session.requireRole('admin');
document.getElementById('whoBox').textContent = `${me.name} (${me.loginId})`;

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.main > section').forEach((s) => (s.style.display = 'none'));
    document.getElementById(`view-${btn.dataset.view}`).style.display = 'block';
    if (btn.dataset.view === 'teachers') loadTeachers();
    if (btn.dataset.view === 'students') loadStudents();
    if (btn.dataset.view === 'restore') initRestoreView();
    if (btn.dataset.view === 'delete') initDeleteView();
  });
});

async function loadStats() {
  const s = await api('/admin/stats');
  const grid = document.getElementById('statsGrid');
  grid.innerHTML = '';
  const items = [
    ['Teachers', s.teachers], ['Students', s.students], ['Classes', s.classes],
    ['Quizzes', s.quizzes], ['Attempts', s.attempts], ['Proctor Alerts', s.proctorAlerts]
  ];
  for (const [label, num] of items) {
    grid.innerHTML += `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`;
  }
}

async function loadTeachers() {
  const teachers = await api('/admin/teachers');
  const rows = document.getElementById('teacherRows');
  rows.innerHTML = teachers.map((t) => `
    <tr>
      <td>${t.name}</td>
      <td>${t.email}</td>
      <td><code>${t.loginId}</code></td>
      <td>${(t.departments && t.departments.length ? t.departments.join(', ') : t.department) || '-'}</td>
      <td><span class="badge ${t.status === 'active' ? 'ok' : 'danger'}">${t.status}</span>${t.resetRequested ? ' <span class="badge warn">Reset requested</span>' : ''}</td>
      <td>
        <button class="btn ghost" onclick="resetTeacherPw('${t.id}')">Reset password</button>
        <button class="btn ghost" onclick="toggleTeacher('${t.id}','${t.status}')">${t.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeTeacher('${t.id}')">Remove</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted)">No teachers yet.</td></tr>';
}

async function loadStudents() {
  const students = await api('/admin/students');
  const rows = document.getElementById('studentRows');
  rows.innerHTML = students.map((s) => `
    <tr><td>${s.name}</td><td>${s.email}</td><td><code>${s.loginId}</code></td><td>${s.rollNumber || '-'}</td><td>${s.department || '-'}</td><td>${(s.teacherNames || []).join(', ') || '-'}</td>
    <td>${s.resetRequested ? '<span class="badge warn">Reset requested</span> ' : ''}<button class="btn ghost" onclick="resetStudentPw('${s.id}')">Reset password</button> <button class="btn ghost" style="color:var(--danger)" onclick="removeStudent('${s.id}')">Remove</button></td></tr>
  `).join('') || '<tr><td colspan="7" style="color:var(--muted)">No students yet.</td></tr>';
}

async function removeTeacher(id) {
  if (!confirm('Remove this teacher?\n\nTheir account and ALL their data will be deleted: classes, quizzes, results, attendance and proctoring images. Students are kept.\n\nYou can bring it back from Restore Data → Admin\'s removals.')) return;
  try {
    await api(`/admin/teachers/${id}`, { method: 'DELETE' });
    toast('Teacher removed');
    loadTeachers();
    loadStats();
  } catch (e) { alert(e.message); }
}

async function removeStudent(id) {
  if (!confirm('Remove this student?\n\nTheir account and ALL their data will be deleted for every teacher: class memberships, attendance, quiz attempts and proctoring images.\n\nYou can bring it back from Restore Data → Admin\'s removals.')) return;
  try {
    await api(`/admin/students/${id}`, { method: 'DELETE' });
    toast('Student removed');
    loadStudents();
    loadStats();
  } catch (e) { alert(e.message); }
}

async function toggleTeacher(id, currentStatus) {
  const status = currentStatus === 'active' ? 'suspended' : 'active';
  await api(`/admin/teachers/${id}/status`, { method: 'PATCH', body: { status } });
  loadTeachers();
}

async function resetTeacherPw(id) {
  const data = await api(`/admin/teachers/${id}/reset-password`, { method: 'POST' });
  alert(`New temporary password: ${data.temporaryPassword}\n\nShare this with the teacher — they'll be asked to change it on next login.`);
}

async function resetStudentPw(id) {
  const data = await api(`/admin/students/${id}/reset-password`, { method: 'POST' });
  alert(`New temporary password: ${data.temporaryPassword}\n\nShare this with the student — they'll be asked to change it on next login.`);
  loadStudents();
}

function openAddTeacher() {
  document.getElementById('addTeacherModal').style.display = 'flex';
  document.getElementById('credsResult').innerHTML = '';
  document.getElementById('addTeacherError').textContent = '';
  document.getElementById('addTeacherForm').style.display = 'block';
  document.getElementById('addTeacherForm').reset();
}
function closeAddTeacher() {
  document.getElementById('addTeacherModal').style.display = 'none';
}

document.getElementById('addTeacherForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('tName').value.trim();
  const email = document.getElementById('tEmail').value.trim();
  const departments = [...document.querySelectorAll('#tDeptList input:checked')].map((c) => c.value);
  const err = document.getElementById('addTeacherError');
  err.textContent = '';
  if (!departments.length) { err.textContent = 'Select at least one department.'; return; }
  try {
    const data = await api('/admin/teachers', { method: 'POST', body: { name, email, departments } });
    document.getElementById('addTeacherForm').style.display = 'none';
    document.getElementById('credsResult').innerHTML = `
      <p style="font-size:13px;color:var(--muted)">Teacher created! Share these credentials with them:</p>
      <div class="credential-box">
        Login ID: ${data.credentials.loginId}<br/>
        Temporary password: ${data.credentials.temporaryPassword}<br/>
        Email: ${data.credentials.email}
      </div>
      <button class="btn full" style="margin-top:14px" onclick="closeAddTeacher(); loadTeachers();">Done</button>
    `;
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// ---------------- Add student ----------------------------------------------
let teachersCache = [];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function teacherDeptText(t) {
  return (t.departments && t.departments.length ? t.departments.join(', ') : t.department) || 'no dept';
}

async function openAddStudent() {
  document.getElementById('addStudentForm').reset();
  document.getElementById('addStudentForm').style.display = 'block';
  document.getElementById('studentCredsResult').innerHTML = '';
  document.getElementById('addStudentError').textContent = '';
  document.getElementById('addStudentModal').style.display = 'flex';
  teachersCache = await api('/admin/teachers');
  document.getElementById('sTeacherList').innerHTML = teachersCache.map((t) => `
    <label class="check-item"><input type="checkbox" value="${t.id}" /> ${escapeHtml(t.name)} <small>(${escapeHtml(teacherDeptText(t))})</small></label>
  `).join('') || '<span style="color:var(--muted);font-size:13px">No teachers yet — add a teacher first.</span>';
  refreshAssignUi();
}
function closeAddStudent() {
  document.getElementById('addStudentModal').style.display = 'none';
}

function currentAssignMode() {
  return document.querySelector('input[name="sMode"]:checked').value;
}

function refreshAssignUi() {
  const mode = currentAssignMode();
  document.getElementById('sTeacherPicker').style.display = mode === 'selected' ? 'block' : 'none';
  const dept = document.getElementById('sDept').value;
  const n = dept ? teachersCache.filter((t) => (t.departments || []).includes(dept)).length : 0;
  document.getElementById('sDomainHint').textContent = dept ? `(${dept}: ${n} teacher${n === 1 ? '' : 's'})` : '(pick a domain first)';
}
document.querySelectorAll('input[name="sMode"]').forEach((r) => r.addEventListener('change', refreshAssignUi));
document.getElementById('sDept').addEventListener('change', refreshAssignUi);

document.getElementById('addStudentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('addStudentError');
  err.textContent = '';
  const body = {
    name: document.getElementById('sName').value.trim(),
    email: document.getElementById('sEmail').value.trim(),
    department: document.getElementById('sDept').value,
    assignMode: currentAssignMode(),
    teacherIds: [...document.querySelectorAll('#sTeacherList input:checked')].map((c) => c.value)
  };
  if (!body.department) { err.textContent = 'Select the student domain.'; return; }
  if (body.assignMode === 'selected' && !body.teacherIds.length) { err.textContent = 'Select at least one teacher.'; return; }
  try {
    const data = await api('/admin/students', { method: 'POST', body });
    document.getElementById('addStudentForm').style.display = 'none';
    document.getElementById('studentCredsResult').innerHTML = `
      <p style="font-size:13px;color:var(--muted)">Student created! Share these credentials with them:</p>
      <div class="credential-box">
        Login ID: ${escapeHtml(data.credentials.loginId)}<br/>
        Temporary password: ${escapeHtml(data.credentials.temporaryPassword)}<br/>
        Email: ${escapeHtml(data.credentials.email)}<br/>
        Roll number: ${escapeHtml(data.student.rollNumber)} &nbsp;•&nbsp; Domain: ${escapeHtml(data.student.department)}
      </div>
      <p style="font-size:13px;color:var(--muted)">Added to ${data.assignedTeachers.length} teacher(s): ${escapeHtml(data.assignedTeachers.join(', '))}</p>
      <button class="btn full" style="margin-top:14px" onclick="closeAddStudent(); loadStudents(); loadStats();">Done</button>
    `;
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// ---------------- Restore / Delete data ----------------------------------------
// Time ranges: a number of days back, or 'all'.
const RANGE_OPTIONS = [
  ['1', 'Past 1 day'], ['2', 'Past 2 days'], ['3', 'Past 3 days'], ['4', 'Past 4 days'],
  ['5', 'Past 5 days'], ['6', 'Past 6 days'],
  ['7', 'Past 1 week'], ['14', 'Past 2 weeks'], ['21', 'Past 3 weeks'], ['28', 'Past 4 weeks'],
  ['30', 'Past 1 month'], ['60', 'Past 2 months'], ['90', 'Past 3 months'], ['120', 'Past 4 months'],
  ['150', 'Past 5 months'], ['180', 'Past 6 months'],
  ['all', 'All time (since the project began)']
];

function fillRangeSelect(id, selected) {
  document.getElementById(id).innerHTML = RANGE_OPTIONS
    .map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}

async function fillTeacherChecks(listId) {
  const teachers = await api('/admin/teachers');
  document.getElementById(listId).innerHTML = teachers.map((t) => `
    <label class="check-item"><input type="checkbox" value="${t.id}" /> ${escapeHtml(t.name)} <small>(${escapeHtml(teacherDeptText(t))})</small></label>
  `).join('') || '<span style="color:var(--muted);font-size:13px">No teachers yet.</span>';
}

function pickedTeachers(listId) {
  return [...document.querySelectorAll(`#${listId} input:checked`)].map((c) => c.value);
}

function wireScope(radioName, boxId) {
  document.querySelectorAll(`input[name="${radioName}"]`).forEach((r) => {
    r.onchange = () => {
      document.getElementById(boxId).style.display =
        document.querySelector(`input[name="${radioName}"]:checked`).value === 'selected' ? 'block' : 'none';
    };
  });
}

function totalsText(t) {
  const parts = [];
  if (t.teacherAccounts) parts.push(`${t.teacherAccounts} teacher account`);
  if (t.studentAccounts) parts.push(`${t.studentAccounts} student account`);
  if (t.classes) parts.push(`${t.classes} class(es)`);
  if (t.quizzes) parts.push(`${t.quizzes} quiz(zes)`);
  if (t.attempts) parts.push(`${t.attempts} student attempt(s)`);
  if (t.proctorEvents) parts.push(`${t.proctorEvents} proctoring alert(s)`);
  if (t.images) parts.push(`${t.images} proctoring image(s)`);
  if (t.attendance) parts.push(`${t.attendance} attendance record(s)`);
  if (t.enrollments) parts.push(`${t.enrollments} class membership(s)`);
  return parts.join(', ') || 'nothing';
}

const KIND_LABEL = {
  class: 'Class', quiz: 'Quiz', image: 'Proctoring image(s)',
  admin_teacher: 'Teacher removed', admin_student: 'Student removed', student_unlink: 'Student removed by teacher'
};

// ---- Restore ----
let trashCache = [];
async function initRestoreView() {
  fillRangeSelect('rRange', '7');
  wireScope('rScope', 'rTeacherBox');
  document.getElementById('rResult').innerHTML = '';
  await fillTeacherChecks('rTeacherList');
}

function restoreFilter() {
  const scope = document.querySelector('input[name="rScope"]:checked').value;
  const teacherIds = pickedTeachers('rTeacherList');
  if (scope === 'selected' && !teacherIds.length) { alert('Select at least one teacher.'); return null; }
  return { scope, teacherIds, range: document.getElementById('rRange').value };
}

async function showTrash() {
  const f = restoreFilter();
  if (!f) return;
  const box = document.getElementById('rResult');
  box.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
  try {
    const q = `scope=${f.scope}&range=${f.range}&teacherIds=${f.teacherIds.join(',')}`;
    const data = await api(`/admin/trash?${q}`);
    trashCache = data.items;
    if (!data.items.length) {
      box.innerHTML = '<div class="panel"><p style="margin:0;color:var(--muted)">Nothing deleted in this period — there is nothing to restore.</p></div>';
      return;
    }
    box.innerHTML = `
      <div class="panel">
        <h3>${data.items.length} deleted item(s) found</h3>
        <p style="color:var(--muted);font-size:13px;margin-top:-6px">Restoring will bring back: ${escapeHtml(totalsText(data.totals))}.</p>
        <button class="btn" onclick="restoreListed()">Restore all ${data.items.length} item(s)</button>
      </div>
      <table>
        <thead><tr><th>Teacher</th><th>Type</th><th>Name</th><th>Contains</th><th>Deleted</th><th>By</th><th></th></tr></thead>
        <tbody>${data.items.map((i) => `
          <tr>
            <td>${escapeHtml(i.teacherName)}</td>
            <td>${KIND_LABEL[i.kind] || i.kind}</td>
            <td>${escapeHtml(i.label)}</td>
            <td style="max-width:240px">${escapeHtml(totalsText(i.counts))}</td>
            <td>${new Date(i.deletedAt).toLocaleString()}</td>
            <td>${i.by === 'admin' ? 'Admin' : 'Teacher'}</td>
            <td><button class="btn ghost" onclick="restoreOne('${i.id}')">Restore</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    box.innerHTML = `<p class="error-msg">${escapeHtml(e.message)}</p>`;
  }
}

function reportRestore(r) {
  let msg = `Restored ${r.restoredCount} item(s).`;
  if (r.skipped.length) msg += `\n\nNot restored:\n` + r.skipped.map((s) => `• ${s.label} — ${s.reason}`).join('\n');
  if (r.warnings.length) msg += `\n\nNote:\n` + [...new Set(r.warnings)].map((w) => `• ${w}`).join('\n');
  alert(msg);
}

async function restoreListed() {
  const f = restoreFilter();
  if (!f) return;
  if (!confirm(`Restore all ${trashCache.length} listed item(s)?`)) return;
  try {
    reportRestore(await api('/admin/trash/restore', { method: 'POST', body: f }));
    showTrash();
  } catch (e) { alert(e.message); }
}

async function restoreOne(trashId) {
  try {
    reportRestore(await api('/admin/trash/restore', { method: 'POST', body: { ids: [trashId] } }));
    showTrash();
  } catch (e) { alert(e.message); }
}

// ---- Delete ----
async function initDeleteView() {
  fillRangeSelect('dRange', '7');
  wireScope('dScope', 'dTeacherBox');
  document.getElementById('dResult').innerHTML = '';
  await fillTeacherChecks('dTeacherList');
  // Changing any option invalidates an earlier preview
  document.getElementById('view-delete').onchange = () => { document.getElementById('dResult').innerHTML = ''; };
}

function deleteRequest(extra = {}) {
  const scope = document.querySelector('input[name="dScope"]:checked').value;
  const teacherIds = pickedTeachers('dTeacherList');
  if (scope === 'selected' && !teacherIds.length) { alert('Select at least one teacher.'); return null; }
  const categories = {
    classes: document.getElementById('dCatClasses').checked,
    quizzes: document.getElementById('dCatQuizzes').checked,
    images: document.getElementById('dCatImages').checked
  };
  if (!categories.classes && !categories.quizzes && !categories.images) { alert('Choose what to delete.'); return null; }
  return {
    scope, teacherIds, categories,
    range: document.getElementById('dRange').value,
    permanent: document.getElementById('dPermanent').checked,
    ...extra
  };
}

async function previewDelete() {
  const body = deleteRequest({ dryRun: true });
  if (!body) return;
  const box = document.getElementById('dResult');
  try {
    const r = await api('/admin/data/delete', { method: 'POST', body });
    if (!r.units) {
      box.innerHTML = '<div class="panel"><p style="margin:0;color:var(--muted)">No matching data found — nothing would be deleted.</p></div>';
      return;
    }
    box.innerHTML = `
      <div class="panel" style="border-color:var(--danger)">
        <h3 style="color:var(--danger)">This will delete</h3>
        <p style="font-size:14px">${escapeHtml(totalsText(r.totals))}</p>
        <p style="color:var(--muted);font-size:13px">
          ${body.permanent ? '<b style="color:var(--danger)">Permanent — this cannot be undone.</b>' : 'You can bring it back later from Restore Data.'}
        </p>
        <button class="btn danger" onclick="runDelete()">${body.permanent ? 'Delete permanently' : 'Delete now'}</button>
      </div>`;
  } catch (e) {
    box.innerHTML = `<p class="error-msg">${escapeHtml(e.message)}</p>`;
  }
}

async function runDelete() {
  const body = deleteRequest();
  if (!body) return;
  if (!confirm(body.permanent ? 'Permanently delete this data? This cannot be undone.' : 'Delete this data? (It can be restored from Restore Data.)')) return;
  if (body.scope === 'all' && body.range === 'all') {
    const typed = prompt('You are about to delete ALL data of ALL teachers.\nType DELETE to confirm:');
    if (typed !== 'DELETE') { alert('Cancelled.'); return; }
  }
  try {
    const r = await api('/admin/data/delete', { method: 'POST', body });
    document.getElementById('dResult').innerHTML = `
      <div class="panel"><p style="margin:0">✅ Deleted: ${escapeHtml(totalsText(r.totals))}.
      ${r.permanent ? '' : 'You can restore it from <b>Restore Data</b>.'}</p></div>`;
    loadStats();
  } catch (e) { alert(e.message); }
}

loadStats();
