// Admin dashboard — the same page serves two kinds of admin:
//   * Global (platform) admin: manages colleges and sees every college's data.
//   * College admin: sees and manages only their own college.
// `ctx` (from GET /api/admin/me) tells which one is signed in.
const me = Session.requireRole('admin');
let ctx = { isGlobal: false, college: null };
let collegesCache = [];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function showModal(id) { document.getElementById(id).style.display = 'flex'; }

// ---------------- Start-up ----------------------------------------------------
async function init() {
  try {
    ctx = await api('/admin/me');
  } catch (e) { alert(e.message); return; }

  document.getElementById('whoBox').textContent = `${ctx.name} (${ctx.loginId})`;
  document.getElementById('whoCollege').textContent = ctx.isGlobal
    ? 'Global admin — all colleges'
    : `${ctx.college.name} (${ctx.college.shortName})`;
  document.title = ctx.isGlobal ? 'Classroom — Global Admin' : `Classroom — ${ctx.college.shortName} Admin`;

  // show the parts that belong to this kind of admin
  document.querySelectorAll('.global-only').forEach((el) => (el.style.display = ctx.isGlobal ? '' : 'none'));
  document.querySelectorAll('.college-only').forEach((el) => (el.style.display = ctx.isGlobal ? 'none' : ''));
  // table header cells must keep table-cell display
  document.querySelectorAll('th.global-only').forEach((el) => (el.style.display = ctx.isGlobal ? 'table-cell' : 'none'));

  document.getElementById('restoreIntro').textContent = ctx.isGlobal
    ? 'Bring back colleges, teachers, students, classes, quizzes (with their results and proctoring alerts) and proctoring images that were deleted by a teacher, a college admin or you.'
    : 'Bring back teachers, students, classes, quizzes (with their results and proctoring alerts) and proctoring images of your college that were deleted by a teacher or by you. Items deleted by the global (platform) admin can only be restored by them.';
  document.getElementById('rAdminHint').textContent = ctx.isGlobal
    ? '(colleges, teachers and students removed by an admin)'
    : '(teachers and students you removed)';
  document.getElementById('deleteIntro').innerHTML = ctx.isGlobal
    ? 'Delete teachers\' data by time range. Deleted data goes to the recycle bin, so you can bring it back from <b>Restore Data</b> (unless you tick permanent delete). Accounts are never deleted here.'
    : 'Delete your teachers\' data by time range. Deleted data goes to the recycle bin and can always be brought back from <b>Restore Data</b>. Accounts are never deleted here.';

  if (ctx.isGlobal) await refreshCollegesCache();
  loadStats();
}

async function refreshCollegesCache() {
  if (!ctx.isGlobal) return;
  collegesCache = await api('/admin/colleges');
}

/** Fills a <select> with colleges. `allLabel` adds an "all colleges" first option. */
function fillCollegeSelect(selectId, { allLabel = null, placeholder = null, selected = '' } = {}) {
  const sel = document.getElementById(selectId);
  const opts = [];
  if (allLabel) opts.push(`<option value="all">${esc(allLabel)}</option>`);
  if (placeholder) opts.push(`<option value="">${esc(placeholder)}</option>`);
  for (const c of collegesCache) {
    opts.push(`<option value="${c.id}">${esc(c.name)} (${esc(c.shortName)})${c.status === 'suspended' ? ' — suspended' : ''}</option>`);
  }
  sel.innerHTML = opts.join('');
  if (selected && [...sel.options].some((o) => o.value === selected)) sel.value = selected;
}

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.main > section').forEach((s) => (s.style.display = 'none'));
    document.getElementById(`view-${btn.dataset.view}`).style.display = 'block';
    const v = btn.dataset.view;
    if (v === 'overview') loadStats();
    if (v === 'colleges') loadColleges();
    if (v === 'teachers') initTeachersView();
    if (v === 'students') initStudentsView();
    if (v === 'restore') initRestoreView();
    if (v === 'delete') initDeleteView();
  });
});

// ---------------- Overview ----------------------------------------------------
async function loadStats() {
  const s = await api('/admin/stats');
  document.getElementById('overviewTitle').textContent = ctx.isGlobal
    ? 'Platform Overview'
    : `College Overview — ${ctx.college.name}`;
  const items = [
    ...(ctx.isGlobal ? [['Colleges', s.colleges]] : []),
    ['Teachers', s.teachers], ['Students', s.students], ['Classes', s.classes],
    ['Quizzes', s.quizzes], ['Attempts', s.attempts], ['Proctor Alerts', s.proctorAlerts]
  ];
  document.getElementById('statsGrid').innerHTML = items
    .map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`).join('');

  document.getElementById('perCollegeBox').innerHTML = ctx.isGlobal ? `
    <h3>By college</h3>
    <div class="table-wrap" style="margin-bottom:24px">
      <table>
        <thead><tr><th>College</th><th>Status</th><th>Teachers</th><th>Students</th><th>Classes</th><th>Quizzes</th><th>Attempts</th><th>Proctor alerts</th></tr></thead>
        <tbody>${(s.perCollege || []).map((c) => `
          <tr>
            <td>${esc(c.name)} <small style="color:var(--muted)">(${esc(c.shortName)})</small></td>
            <td><span class="badge ${c.status === 'active' ? 'ok' : 'danger'}">${esc(c.status)}</span></td>
            <td>${c.teachers}</td><td>${c.students}</td><td>${c.classes}</td><td>${c.quizzes}</td><td>${c.attempts}</td><td>${c.proctorAlerts}</td>
          </tr>`).join('') || '<tr><td colspan="8" style="color:var(--muted)">No colleges yet — add one from the Colleges tab.</td></tr>'}
        </tbody>
      </table>
    </div>` : '';

  document.getElementById('howToPanel').innerHTML = ctx.isGlobal ? `
    <h3>How it works</h3>
    <p style="color:var(--muted);font-size:14px;margin:0">
      Go to <b>Colleges → + Add College</b> and enter the college name, its short name (e.g. <code>JIIT</code>) and the college admin's
      name and email. The college admin gets a login ID and temporary password and signs in from the normal <b>Admin</b> tab —
      they only ever see their own college. You can also add teachers and students to any college yourself; each college's
      roll numbers run on their own (<code>JIIT1</code>, <code>JIIT2</code> …).
    </p>` : `
    <h3>How adding a teacher works</h3>
    <p style="color:var(--muted);font-size:14px;margin:0">
      Click <b>Teachers → + Add Teacher</b>, enter their name, email and pick their department(s) (CSE, IT, ECE, CIVIL).
      They are added to <b>${esc(ctx.college.name)}</b> automatically with a temporary password and a Teacher ID
      (e.g. <code>TCH1024</code>). Share those with the teacher — they will be asked to set their own password on first login.
      Students you add get roll numbers <code>${esc(ctx.college.shortName)}1</code>, <code>${esc(ctx.college.shortName)}2</code> … automatically.
    </p>`;
}

// ---------------- Colleges (global) ---------------------------------------------
async function loadColleges() {
  await refreshCollegesCache();
  document.getElementById('collegeRows').innerHTML = collegesCache.map((c) => {
    const a = c.admin;
    const adminCell = a
      ? `${esc(a.name)}<br/><small style="color:var(--muted)">${esc(a.email)} · <code>${esc(a.loginId)}</code></small>${a.resetRequested ? '<br/><span class="badge warn">Reset requested</span>' : ''}`
      : '<span class="badge warn">No admin yet</span>';
    return `
    <tr>
      <td><b>${esc(c.name)}</b></td>
      <td><code>${esc(c.shortName)}</code></td>
      <td>${adminCell}</td>
      <td>${c.teachers}</td>
      <td>${c.students}</td>
      <td><code>${esc(c.nextRollNumber)}</code></td>
      <td><span class="badge ${c.status === 'active' ? 'ok' : 'danger'}">${esc(c.status)}</span></td>
      <td class="actions">
        <button class="btn ghost" onclick="openEditCollege('${c.id}')">Edit</button>
        ${a ? `<button class="btn ghost" onclick="resetCollegeAdminPw('${c.id}')">Reset admin password</button>`
            : `<button class="btn ghost" onclick="openCollegeAdmin('${c.id}')">Create admin</button>`}
        <button class="btn ghost" onclick="toggleCollege('${c.id}','${c.status}')">${c.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeCollege('${c.id}')">Remove</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="color:var(--muted)">No colleges yet.</td></tr>';
}

// Short-name suggestion: initials, skipping "of", "the", "and" … (same rule as the server)
const SKIP_WORDS = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'a', 'an', '&']);
function suggestShortName(name) {
  return String(name || '').replace(/[^A-Za-z0-9&\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !SKIP_WORDS.has(w.toLowerCase()))
    .map((w) => w[0]).join('').toUpperCase().slice(0, 10);
}
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

let shortEdited = false;
function updateShortHint() {
  const name = document.getElementById('cName').value;
  const short = document.getElementById('cShort').value.trim().toUpperCase();
  const hint = document.getElementById('cShortHint');
  const nameClash = name.trim() && collegesCache.some((c) => normName(c.name) === normName(name));
  const shortClash = short && collegesCache.some((c) => c.shortName.toUpperCase() === short);
  if (nameClash) { hint.style.color = 'var(--danger)'; hint.textContent = 'A college with this name already exists.'; }
  else if (shortClash) { hint.style.color = 'var(--danger)'; hint.textContent = `"${short}" is already used by another college — choose a different short name.`; }
  else if (short) { hint.style.color = ''; hint.textContent = `Roll numbers will be ${short}1, ${short}2, ${short}3 …`; }
  else hint.textContent = '';
}
document.getElementById('cName').addEventListener('input', () => {
  if (!shortEdited) document.getElementById('cShort').value = suggestShortName(document.getElementById('cName').value);
  updateShortHint();
});
document.getElementById('cShort').addEventListener('input', () => {
  shortEdited = document.getElementById('cShort').value.trim() !== '';
  updateShortHint();
});

async function openAddCollege() {
  await refreshCollegesCache();
  shortEdited = false;
  const form = document.getElementById('addCollegeForm');
  form.reset();
  form.style.display = 'block';
  document.getElementById('cShortHint').textContent = '';
  document.getElementById('addCollegeError').textContent = '';
  document.getElementById('collegeCredsResult').innerHTML = '';
  showModal('addCollegeModal');
}

function credsHtml(title, c, extra = '', doneJs = '') {
  return `
    <p style="font-size:13px;color:var(--muted)">${title}</p>
    <div class="credential-box">
      Login ID: ${esc(c.loginId)}<br/>
      Temporary password: ${esc(c.temporaryPassword)}<br/>
      Email: ${esc(c.email)}${extra}
    </div>
    <button class="btn full" style="margin-top:14px" onclick="${doneJs}">Done</button>`;
}

document.getElementById('addCollegeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('addCollegeError');
  err.textContent = '';
  const body = {
    name: document.getElementById('cName').value.trim(),
    shortName: document.getElementById('cShort').value.trim().toUpperCase(),
    adminName: document.getElementById('cAdminName').value.trim(),
    adminEmail: document.getElementById('cAdminEmail').value.trim()
  };
  try {
    const data = await api('/admin/colleges', { method: 'POST', body });
    document.getElementById('addCollegeForm').style.display = 'none';
    document.getElementById('collegeCredsResult').innerHTML = credsHtml(
      `College <b>${esc(data.college.name)}</b> (${esc(data.college.shortName)}) created. Share these college admin credentials — they sign in from the <b>Admin</b> tab:`,
      data.credentials, '', "closeModal('addCollegeModal'); loadColleges(); loadStats();");
  } catch (e2) { err.textContent = e2.message; }
});

let editingCollegeId = null;
function openEditCollege(id) {
  const c = collegesCache.find((x) => x.id === id);
  if (!c) return;
  editingCollegeId = id;
  document.getElementById('eName').value = c.name;
  document.getElementById('eShort').value = c.shortName;
  document.getElementById('eAdminBox').style.display = c.admin ? 'block' : 'none';
  document.getElementById('eAdminName').value = c.admin?.name || '';
  document.getElementById('eAdminEmail').value = c.admin?.email || '';
  document.getElementById('editCollegeError').textContent = '';
  showModal('editCollegeModal');
}
document.getElementById('editCollegeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = collegesCache.find((x) => x.id === editingCollegeId);
  const err = document.getElementById('editCollegeError');
  err.textContent = '';
  const body = {
    name: document.getElementById('eName').value.trim(),
    shortName: document.getElementById('eShort').value.trim().toUpperCase()
  };
  if (c?.admin) {
    body.adminName = document.getElementById('eAdminName').value.trim();
    body.adminEmail = document.getElementById('eAdminEmail').value.trim();
  }
  if (c && body.shortName !== c.shortName &&
      !confirm(`Change the short name from ${c.shortName} to ${body.shortName}?\n\nAll ${c.students} student roll number(s) of this college will change too (e.g. ${c.shortName}1 → ${body.shortName}1).`)) return;
  try {
    await api(`/admin/colleges/${editingCollegeId}`, { method: 'PATCH', body });
    closeModal('editCollegeModal');
    toast('College updated');
    loadColleges();
  } catch (e2) { err.textContent = e2.message; }
});

let adminForCollegeId = null;
function openCollegeAdmin(id) {
  const c = collegesCache.find((x) => x.id === id);
  adminForCollegeId = id;
  document.getElementById('caCollegeName').textContent = c ? `${c.name} (${c.shortName})` : '';
  const form = document.getElementById('collegeAdminForm');
  form.reset();
  form.style.display = 'block';
  document.getElementById('collegeAdminError').textContent = '';
  document.getElementById('caCredsResult').innerHTML = '';
  showModal('collegeAdminModal');
}
document.getElementById('collegeAdminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('collegeAdminError');
  err.textContent = '';
  try {
    const data = await api(`/admin/colleges/${adminForCollegeId}/admin`, {
      method: 'POST',
      body: { adminName: document.getElementById('caName').value.trim(), adminEmail: document.getElementById('caEmail').value.trim() }
    });
    document.getElementById('collegeAdminForm').style.display = 'none';
    document.getElementById('caCredsResult').innerHTML = credsHtml('College admin created. Share these credentials:', data.credentials, '', "closeModal('collegeAdminModal'); loadColleges();");
  } catch (e2) { err.textContent = e2.message; }
});

async function resetCollegeAdminPw(id) {
  const c = collegesCache.find((x) => x.id === id);
  if (!confirm(`Generate a new temporary password for the admin of ${c ? c.name : 'this college'}?`)) return;
  try {
    const data = await api(`/admin/colleges/${id}/reset-password`, { method: 'POST' });
    alert(`New temporary password: ${data.temporaryPassword}\n\nShare this with the college admin — they'll be asked to change it on next login.`);
    loadColleges();
  } catch (e) { alert(e.message); }
}

async function toggleCollege(id, current) {
  const c = collegesCache.find((x) => x.id === id);
  const suspend = current === 'active';
  if (suspend && !confirm(`Suspend ${c ? c.name : 'this college'}?\n\nIts college admin, all of its teachers and all of its students will be signed out and unable to sign in until you reactivate it. No data is deleted.`)) return;
  try {
    await api(`/admin/colleges/${id}/status`, { method: 'PATCH', body: { status: suspend ? 'suspended' : 'active' } });
    toast(suspend ? 'College suspended' : 'College reactivated');
    loadColleges();
  } catch (e) { alert(e.message); }
}

async function removeCollege(id) {
  const c = collegesCache.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`Remove ${c.name} (${c.shortName})?\n\nThis deletes the college, its college admin, all ${c.teachers} teacher(s) and ${c.students} student(s), and ALL of their classes, quizzes, results, attendance and proctoring images.\n\nYou can bring it back from Restore Data → Admin's removals.`)) return;
  const typed = prompt(`Type the short name ${c.shortName} to confirm:`);
  if ((typed || '').trim().toUpperCase() !== c.shortName.toUpperCase()) { alert('Cancelled.'); return; }
  try {
    await api(`/admin/colleges/${id}`, { method: 'DELETE' });
    toast('College removed');
    loadColleges();
    loadStats();
  } catch (e) { alert(e.message); }
}

// ---------------- Teachers ----------------------------------------------------
function teacherDeptText(t) {
  return (t.departments && t.departments.length ? t.departments.join(', ') : t.department) || 'no dept';
}

async function initTeachersView() {
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    const sel = document.getElementById('teacherCollegeFilter');
    const keep = sel.value || 'all';
    fillCollegeSelect('teacherCollegeFilter', { allLabel: 'All colleges', selected: keep });
    sel.onchange = loadTeachers;
  }
  loadTeachers();
}

async function loadTeachers() {
  const cid = ctx.isGlobal ? document.getElementById('teacherCollegeFilter').value : '';
  const teachers = await api(`/admin/teachers${cid && cid !== 'all' ? `?collegeId=${cid}` : ''}`);
  document.getElementById('teacherRows').innerHTML = teachers.map((t) => `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${esc(t.email)}</td>
      <td><code>${esc(t.loginId)}</code></td>
      ${ctx.isGlobal ? `<td>${esc(t.collegeShort || t.collegeName)}</td>` : ''}
      <td>${esc(teacherDeptText(t))}</td>
      <td><span class="badge ${t.status === 'active' ? 'ok' : 'danger'}">${esc(t.status)}</span>${t.resetRequested ? ' <span class="badge warn">Reset requested</span>' : ''}</td>
      <td class="actions">
        <button class="btn ghost" onclick="resetTeacherPw('${t.id}')">Reset password</button>
        <button class="btn ghost" onclick="toggleTeacher('${t.id}','${t.status}')">${t.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeTeacher('${t.id}')">Remove</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="${ctx.isGlobal ? 7 : 6}" style="color:var(--muted)">No teachers yet.</td></tr>`;
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

async function toggleTeacher(id, currentStatus) {
  const status = currentStatus === 'active' ? 'suspended' : 'active';
  try {
    await api(`/admin/teachers/${id}/status`, { method: 'PATCH', body: { status } });
    loadTeachers();
  } catch (e) { alert(e.message); }
}

async function resetTeacherPw(id) {
  try {
    const data = await api(`/admin/teachers/${id}/reset-password`, { method: 'POST' });
    alert(`New temporary password: ${data.temporaryPassword}\n\nShare this with the teacher — they'll be asked to change it on next login.`);
    loadTeachers();
  } catch (e) { alert(e.message); }
}

async function openAddTeacher() {
  const form = document.getElementById('addTeacherForm');
  form.reset();
  form.style.display = 'block';
  document.getElementById('credsResult').innerHTML = '';
  document.getElementById('addTeacherError').textContent = '';
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    const filter = document.getElementById('teacherCollegeFilter').value;
    fillCollegeSelect('tCollege', { placeholder: 'Select college…', selected: filter !== 'all' ? filter : '' });
  } else {
    document.getElementById('tCollegeNote').innerHTML = `College: <b>${esc(ctx.college.name)}</b> (added automatically)`;
  }
  showModal('addTeacherModal');
}

document.getElementById('addTeacherForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('tName').value.trim();
  const email = document.getElementById('tEmail').value.trim();
  const departments = [...document.querySelectorAll('#tDeptList input:checked')].map((c) => c.value);
  const err = document.getElementById('addTeacherError');
  err.textContent = '';
  const body = { name, email, departments };
  if (ctx.isGlobal) {
    body.collegeId = document.getElementById('tCollege').value;
    if (!body.collegeId) { err.textContent = 'Select the college.'; return; }
  }
  if (!departments.length) { err.textContent = 'Select at least one department.'; return; }
  try {
    const data = await api('/admin/teachers', { method: 'POST', body });
    document.getElementById('addTeacherForm').style.display = 'none';
    document.getElementById('credsResult').innerHTML = credsHtml('Teacher created! Share these credentials with them:', data.credentials,
      `<br/>College: ${esc(data.teacher.collegeName)}`, "closeModal('addTeacherModal'); loadTeachers(); loadStats();");
  } catch (e2) { err.textContent = e2.message; }
});

// ---------------- Students ----------------------------------------------------
let studentsCache = [];

async function initStudentsView() {
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    const sel = document.getElementById('studentCollegeFilter');
    const keep = sel.value || 'all';
    fillCollegeSelect('studentCollegeFilter', { allLabel: 'All colleges', selected: keep });
    sel.onchange = loadStudents;
  }
  document.getElementById('studentSearch').oninput = renderStudents;
  loadStudents();
}

async function loadStudents() {
  const cid = ctx.isGlobal ? document.getElementById('studentCollegeFilter').value : '';
  studentsCache = await api(`/admin/students${cid && cid !== 'all' ? `?collegeId=${cid}` : ''}`);
  renderStudents();
}

function renderStudents() {
  const q = document.getElementById('studentSearch').value.trim().toLowerCase();
  const list = !q ? studentsCache : studentsCache.filter((s) =>
    [s.name, s.rollNumber, s.email, s.loginId].some((v) => String(v || '').toLowerCase().includes(q)));
  const cols = ctx.isGlobal ? 9 : 8;
  document.getElementById('studentRows').innerHTML = list.map((s) => `
    <tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.email)}</td>
      <td><code>${esc(s.loginId)}</code></td>
      <td><b>${esc(s.rollNumber || '-')}</b></td>
      ${ctx.isGlobal ? `<td>${esc(s.collegeShort || s.collegeName)}</td>` : ''}
      <td>${esc(s.department || '-')}</td>
      <td>${esc((s.teacherNames || []).join(', ') || '-')}</td>
      <td><span class="badge ${s.status === 'active' ? 'ok' : 'danger'}">${esc(s.status)}</span>${s.resetRequested ? ' <span class="badge warn">Reset requested</span>' : ''}</td>
      <td class="actions">
        <button class="btn ghost" onclick="resetStudentPw('${s.id}')">Reset password</button>
        <button class="btn ghost" onclick="toggleStudent('${s.id}','${s.status}')">${s.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeStudent('${s.id}')">Remove</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="${cols}" style="color:var(--muted)">${q ? 'No students match your search.' : 'No students yet.'}</td></tr>`;
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

async function toggleStudent(id, currentStatus) {
  const suspend = currentStatus === 'active';
  if (suspend && !confirm('Suspend this student?\n\nThey will be signed out and unable to sign in until reactivated. No data is deleted.')) return;
  try {
    await api(`/admin/students/${id}/status`, { method: 'PATCH', body: { status: suspend ? 'suspended' : 'active' } });
    toast(suspend ? 'Student suspended' : 'Student reactivated');
    loadStudents();
  } catch (e) { alert(e.message); }
}

async function resetStudentPw(id) {
  try {
    const data = await api(`/admin/students/${id}/reset-password`, { method: 'POST' });
    alert(`New temporary password: ${data.temporaryPassword}\n\nShare this with the student — they'll be asked to change it on next login.`);
    loadStudents();
  } catch (e) { alert(e.message); }
}

// ---- Add student ----
let teachersCache = [];

function addStudentCollegeId() {
  return ctx.isGlobal ? document.getElementById('sCollege').value : ctx.college.id;
}

async function openAddStudent() {
  const form = document.getElementById('addStudentForm');
  form.reset();
  form.style.display = 'block';
  document.getElementById('studentCredsResult').innerHTML = '';
  document.getElementById('addStudentError').textContent = '';
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    const filter = document.getElementById('studentCollegeFilter').value;
    fillCollegeSelect('sCollege', { placeholder: 'Select college…', selected: filter !== 'all' ? filter : '' });
    document.getElementById('sCollege').onchange = loadStudentTeacherList;
  } else {
    document.getElementById('sCollegeNote').innerHTML = `College: <b>${esc(ctx.college.name)}</b> (added automatically)`;
  }
  showModal('addStudentModal');
  await loadStudentTeacherList();
}

// Teachers to pick from = teachers of the chosen college only
async function loadStudentTeacherList() {
  const cid = addStudentCollegeId();
  const list = document.getElementById('sTeacherList');
  if (!cid) {
    teachersCache = [];
    list.innerHTML = '<span style="color:var(--muted);font-size:13px">Select a college first.</span>';
  } else {
    teachersCache = await api(`/admin/teachers${ctx.isGlobal ? `?collegeId=${cid}` : ''}`);
    list.innerHTML = teachersCache.map((t) => `
      <label class="check-item"><input type="checkbox" value="${t.id}" /> ${esc(t.name)} <small>(${esc(teacherDeptText(t))})</small></label>
    `).join('') || '<span style="color:var(--muted);font-size:13px">This college has no teachers yet — add a teacher first, or choose "No teacher for now".</span>';
  }
  refreshAssignUi();
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
  const cid = addStudentCollegeId();
  const college = ctx.isGlobal ? collegesCache.find((c) => c.id === cid) : null;
  document.getElementById('sRollHint').textContent = ctx.isGlobal
    ? (college ? `Roll number is generated automatically (next: ${college.nextRollNumber}).` : 'Roll number is generated automatically.')
    : `Roll number is generated automatically (${ctx.college.shortName}1, ${ctx.college.shortName}2 …).`;
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
  if (ctx.isGlobal) {
    body.collegeId = document.getElementById('sCollege').value;
    if (!body.collegeId) { err.textContent = 'Select the college.'; return; }
  }
  if (!body.department) { err.textContent = 'Select the student domain.'; return; }
  if (body.assignMode === 'selected' && !body.teacherIds.length) { err.textContent = 'Select at least one teacher.'; return; }
  try {
    const data = await api('/admin/students', { method: 'POST', body });
    document.getElementById('addStudentForm').style.display = 'none';
    const assigned = data.assignedTeachers.length
      ? `Added to ${data.assignedTeachers.length} teacher(s): ${esc(data.assignedTeachers.join(', '))}`
      : 'Not added to any teacher yet — teachers of this college can pick this student from their Add Student screen.';
    document.getElementById('studentCredsResult').innerHTML = credsHtml('Student created! Share these credentials with them:', data.credentials,
      `<br/>Roll number: ${esc(data.student.rollNumber)} &nbsp;•&nbsp; Domain: ${esc(data.student.department)}<br/>College: ${esc(data.student.collegeName)}`,
      "closeModal('addStudentModal'); loadStudents(); loadStats();")
      .replace('<button', `<p style="font-size:13px;color:var(--muted)">${assigned}</p><button`);
  } catch (e2) { err.textContent = e2.message; }
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

/** Teacher checkboxes, limited to the college picked in `collegeSelectId` (global admin). */
async function fillTeacherChecks(listId, collegeSelectId) {
  const cid = ctx.isGlobal ? document.getElementById(collegeSelectId).value : '';
  const teachers = await api(`/admin/teachers${cid && cid !== 'all' ? `?collegeId=${cid}` : ''}`);
  document.getElementById(listId).innerHTML = teachers.map((t) => `
    <label class="check-item"><input type="checkbox" value="${t.id}" /> ${esc(t.name)} <small>(${ctx.isGlobal ? `${esc(t.collegeShort)} · ` : ''}${esc(teacherDeptText(t))})</small></label>
  `).join('') || '<span style="color:var(--muted);font-size:13px">No teachers here.</span>';
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
  if (t.colleges) parts.push(`${t.colleges} college(s)`);
  if (t.adminAccounts) parts.push(`${t.adminAccounts} college admin account(s)`);
  if (t.teacherAccounts) parts.push(`${t.teacherAccounts} teacher account(s)`);
  if (t.studentAccounts) parts.push(`${t.studentAccounts} student account(s)`);
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
  admin_college: 'College removed', admin_teacher: 'Teacher removed', admin_student: 'Student removed',
  student_unlink: 'Student removed by teacher'
};

// ---- Restore ----
let trashCache = [];
async function initRestoreView() {
  fillRangeSelect('rRange', '7');
  wireScope('rScope', 'rTeacherBox');
  document.getElementById('rResult').innerHTML = '';
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    fillCollegeSelect('rCollege', { allLabel: 'All colleges' });
    document.getElementById('rCollege').onchange = () => {
      document.getElementById('rResult').innerHTML = '';
      fillTeacherChecks('rTeacherList', 'rCollege');
    };
  }
  await fillTeacherChecks('rTeacherList', 'rCollege');
}

function restoreFilter() {
  const scope = document.querySelector('input[name="rScope"]:checked').value;
  const teacherIds = pickedTeachers('rTeacherList');
  if (scope === 'selected' && !teacherIds.length) { alert('Select at least one teacher.'); return null; }
  return {
    collegeId: ctx.isGlobal ? document.getElementById('rCollege').value : undefined,
    scope, teacherIds, range: document.getElementById('rRange').value
  };
}

async function showTrash() {
  const f = restoreFilter();
  if (!f) return;
  const box = document.getElementById('rResult');
  box.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
  try {
    const q = `scope=${f.scope}&range=${f.range}&teacherIds=${f.teacherIds.join(',')}${f.collegeId ? `&collegeId=${f.collegeId}` : ''}`;
    const data = await api(`/admin/trash?${q}`);
    trashCache = data.items;
    const hiddenNote = data.hiddenGlobal
      ? `<p style="color:var(--muted);font-size:13px;margin:8px 0 0">${data.hiddenGlobal} item(s) in this period were deleted by the global (platform) admin and are not shown — only the global admin can restore them.</p>`
      : '';
    if (!data.items.length) {
      box.innerHTML = `<div class="panel"><p style="margin:0;color:var(--muted)">Nothing deleted in this period — there is nothing to restore.</p>${hiddenNote}</div>`;
      return;
    }
    box.innerHTML = `
      <div class="panel">
        <h3>${data.items.length} deleted item(s) found</h3>
        <p style="color:var(--muted);font-size:13px;margin-top:-6px">Restoring will bring back: ${esc(totalsText(data.totals))}.</p>
        <button class="btn" onclick="restoreListed()">Restore all ${data.items.length} item(s)</button>
        ${hiddenNote}
      </div>
      <div class="table-wrap">
      <table>
        <thead><tr>${ctx.isGlobal ? '<th>College</th>' : ''}<th>Teacher</th><th>Type</th><th>Name</th><th>Contains</th><th>Deleted</th><th>By</th><th></th></tr></thead>
        <tbody>${data.items.map((i) => `
          <tr>
            ${ctx.isGlobal ? `<td>${esc(i.collegeName)}</td>` : ''}
            <td>${esc(i.teacherName)}</td>
            <td>${KIND_LABEL[i.kind] || esc(i.kind)}</td>
            <td>${esc(i.label)}</td>
            <td style="max-width:240px">${esc(totalsText(i.counts))}</td>
            <td>${new Date(i.deletedAt).toLocaleString()}</td>
            <td>${esc(i.byLabel)}</td>
            <td><button class="btn ghost" onclick="restoreOne('${i.id}')">Restore</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  } catch (e) {
    box.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
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
    if (ctx.isGlobal) await refreshCollegesCache();
    showTrash();
    loadStats();
  } catch (e) { alert(e.message); }
}

async function restoreOne(trashId) {
  try {
    reportRestore(await api('/admin/trash/restore', { method: 'POST', body: { ids: [trashId] } }));
    if (ctx.isGlobal) await refreshCollegesCache();
    showTrash();
    loadStats();
  } catch (e) { alert(e.message); }
}

// ---- Delete ----
async function initDeleteView() {
  fillRangeSelect('dRange', '7');
  wireScope('dScope', 'dTeacherBox');
  document.getElementById('dResult').innerHTML = '';
  if (ctx.isGlobal) {
    await refreshCollegesCache();
    fillCollegeSelect('dCollege', { allLabel: 'All colleges' });
    document.getElementById('dCollege').onchange = () => fillTeacherChecks('dTeacherList', 'dCollege');
  }
  await fillTeacherChecks('dTeacherList', 'dCollege');
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
    collegeId: ctx.isGlobal ? document.getElementById('dCollege').value : undefined,
    scope, teacherIds, categories,
    range: document.getElementById('dRange').value,
    permanent: ctx.isGlobal && document.getElementById('dPermanent').checked,
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
        <p style="font-size:14px">${esc(totalsText(r.totals))}</p>
        <p style="color:var(--muted);font-size:13px">
          ${body.permanent ? '<b style="color:var(--danger)">Permanent — this cannot be undone.</b>' : 'You can bring it back later from Restore Data.'}
        </p>
        <button class="btn danger" onclick="runDelete()">${body.permanent ? 'Delete permanently' : 'Delete now'}</button>
      </div>`;
  } catch (e) {
    box.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
  }
}

async function runDelete() {
  const body = deleteRequest();
  if (!body) return;
  if (!confirm(body.permanent ? 'Permanently delete this data? This cannot be undone.' : 'Delete this data? (It can be restored from Restore Data.)')) return;
  if (body.scope === 'all' && body.range === 'all') {
    const whose = ctx.isGlobal
      ? (body.collegeId === 'all' ? 'ALL teachers of ALL colleges' : 'ALL teachers of this college')
      : 'ALL teachers of your college';
    const typed = prompt(`You are about to delete ALL data of ${whose}.\nType DELETE to confirm:`);
    if (typed !== 'DELETE') { alert('Cancelled.'); return; }
  }
  try {
    const r = await api('/admin/data/delete', { method: 'POST', body });
    document.getElementById('dResult').innerHTML = `
      <div class="panel"><p style="margin:0">✅ Deleted: ${esc(totalsText(r.totals))}.
      ${r.permanent ? '' : 'You can restore it from <b>Restore Data</b>.'}</p></div>`;
    loadStats();
  } catch (e) { alert(e.message); }
}

init();
