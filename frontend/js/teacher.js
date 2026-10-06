const me = Session.requireRole('teacher');
document.getElementById('whoBox').textContent = `${me.name} (${me.loginId})`;
api('/teacher/me').then((p) => {
  if (p.collegeName) document.getElementById('whoCollege').textContent = `${p.collegeName}${p.collegeShort ? ` (${p.collegeShort})` : ''}`;
}).catch(() => {});

let classesCache = [];
let studentsCache = [];
let quizzesCache = [];
let questionCount = 0;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.main > section').forEach((s) => (s.style.display = 'none'));
  document.getElementById(`view-${view}`).style.display = 'block';
  if (view === 'classes') loadClasses();
  if (view === 'students') loadStudents();
  if (view === 'quizzes') loadQuizzes();
  if (view === 'results') loadResultsView();
  if (view === 'attendance') loadAttendanceView();
  if (view === 'proctoring') loadProctoringView();
  if (view === 'live') loadLiveView();
  if (view === 'profile') loadProfile('teacher');
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ---------------- Shared helpers ----------------------------------------------
const byRoll = (a, b) => String(a.rollNumber || a.studentRoll || '').localeCompare(String(b.rollNumber || b.studentRoll || ''), undefined, { numeric: true });
const lc = (v) => String(v ?? '').toLowerCase();
const todayLocal = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the user's time zone
const classNameOf = (id) => classesCache.find((c) => c.id === id)?.name || '';

/** Fills a class <select>. `first` = label of the "all" option. Keeps the current choice. */
function fillClassFilter(id, first = 'All classes', extra = '') {
  const sel = document.getElementById(id);
  const keep = sel.value;
  sel.innerHTML = (first ? `<option value="">${escapeHtml(first)}</option>` : '') + extra +
    classesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

// ---------------- Classes ----------------------------------------------
async function loadClasses() {
  [classesCache, studentsCache] = await Promise.all([api('/teacher/classes'), api('/teacher/students')]);
  const el = document.getElementById('classList');
  el.innerHTML = classesCache.map((c) => `
    <div class="panel">
      <h3>${escapeHtml(c.name)}</h3>
      <div class="meta"><span>👥 ${c.studentIds.length} student(s)</span><span>📝 ${c.quizCount || 0} quiz(zes)</span></div>
      <div class="card-actions">
        <button class="btn ghost" onclick="openEnroll('${c.id}')">Manage students</button>
        <button class="btn ghost" onclick="goAttendance('${c.id}')">Attendance</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="deleteClass('${c.id}')">Delete</button>
      </div>
    </div>
  `).join('') || '<div class="empty">No classes yet. Create one to get started.</div>';
}

function goAttendance(classId) {
  switchView('attendance');
  setTimeout(() => {
    const sel = document.getElementById('attClassSelect');
    if ([...sel.options].some((o) => o.value === classId)) { sel.value = classId; onAttClassChange(); }
  }, 150);
}

async function deleteClass(classId) {
  const cls = classesCache.find((c) => c.id === classId);
  if (!confirm(`Delete the class "${cls ? cls.name : ''}"?\n\nThis also deletes its attendance, its quizzes, and their results and proctoring data.`)) return;
  try {
    await api(`/teacher/classes/${classId}`, { method: 'DELETE' });
    quizzesCache = [];
    loadClasses();
  } catch (e) { alert(e.message); }
}

function openNewClass() { document.getElementById('modalNewClass').style.display = 'flex'; }
async function createClass() {
  const name = document.getElementById('newClassName').value.trim();
  if (!name) return;
  await api('/teacher/classes', { method: 'POST', body: { name } });
  document.getElementById('newClassName').value = '';
  closeModal('modalNewClass');
  loadClasses();
}

// Only students who are currently yours are listed; enrolled ones first.
let enrollClassId = null;
function openEnroll(classId) {
  enrollClassId = classId;
  const cls = classesCache.find((c) => c.id === classId);
  document.getElementById('enrollClassName').textContent = cls ? cls.name : '';
  const search = document.getElementById('enrollSearch');
  search.value = '';
  search.oninput = renderEnrollList;
  renderEnrollList();
  document.getElementById('modalEnroll').style.display = 'flex';
}
function renderEnrollList() {
  const cls = classesCache.find((c) => c.id === enrollClassId);
  const q = lc(document.getElementById('enrollSearch').value.trim());
  const list = document.getElementById('enrollList');
  if (!studentsCache.length) { list.innerHTML = '<p style="color:var(--muted)">No students yet — add some from the Students tab.</p>'; return; }
  const rows = studentsCache
    .filter((s) => !q || lc(s.name).includes(q) || lc(s.rollNumber).includes(q))
    .map((s) => ({ s, enrolled: cls.studentIds.includes(s.id) }))
    .sort((a, b) => (b.enrolled - a.enrolled) || byRoll(a.s, b.s));
  list.innerHTML = rows.map(({ s, enrolled }) => `
    <div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:nowrap">
      <div style="min-width:0"><code>${escapeHtml(s.rollNumber || '-')}</code> &nbsp;<b>${escapeHtml(s.name)}</b>
        <div style="color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.email)}</div></div>
      <button class="btn small ${enrolled ? 'secondary' : ''}" onclick="toggleEnroll('${cls.id}','${s.id}', ${enrolled})">${enrolled ? 'Remove' : 'Add'}</button>
    </div>`).join('') || '<p style="color:var(--muted)">No student matches your search.</p>';
}

async function toggleEnroll(classId, studentId, currentlyEnrolled) {
  const path = currentlyEnrolled ? `/teacher/classes/${classId}/unenroll` : `/teacher/classes/${classId}/enroll`;
  try {
    await api(path, { method: 'POST', body: { studentId } });
  } catch (e) { alert(e.message); return; }
  const cls = classesCache.find((c) => c.id === classId);
  if (currentlyEnrolled) cls.studentIds = cls.studentIds.filter((id) => id !== studentId);
  else cls.studentIds.push(studentId);
  renderEnrollList();
}

// ---------------- Students ----------------------------------------------
let myDepartments = [];
let scStudentId = null;

async function loadStudents() {
  [studentsCache, classesCache] = await Promise.all([api('/teacher/students'), api('/teacher/classes')]);
  fillClassFilter('stuClassFilter', 'All classes', '<option value="__none">Not in any class</option>');
  document.getElementById('stuSearch').oninput = renderStudents;
  document.getElementById('stuClassFilter').onchange = renderStudents;
  renderStudents();
}

function renderStudents() {
  const q = lc(document.getElementById('stuSearch').value.trim());
  const cf = document.getElementById('stuClassFilter').value;
  const list = studentsCache
    .filter((s) => !q || [s.name, s.rollNumber, s.email, s.loginId].some((v) => lc(v).includes(q)))
    .filter((s) => !cf || (cf === '__none' ? !(s.classIds || []).length : (s.classIds || []).includes(cf)))
    .sort(byRoll);
  document.getElementById('stuCount').textContent = `Showing ${list.length} of ${studentsCache.length} student(s)`;
  document.getElementById('studentRows').innerHTML = list.map((s) => `
    <tr>
      <td><b>${escapeHtml(s.rollNumber || '-')}</b></td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.email)}</td>
      <td><code>${escapeHtml(s.loginId)}</code></td>
      <td>${escapeHtml(s.department || '-')}</td>
      <td>${escapeHtml((s.classIds || []).map(classNameOf).filter(Boolean).join(', ') || '-')}</td>
      <td class="actions">
        ${s.status === 'suspended' ? '<span class="badge danger">suspended</span>' : ''}
        ${s.resetRequested ? '<span class="badge warn">Reset requested</span>' : ''}
        <button class="btn ghost" onclick="openStudentClasses('${s.id}')">Add to class</button>
        <button class="btn ghost" onclick="resetStudentPw('${s.id}')">Reset password</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeStudent('${s.id}')">Remove</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="7" style="color:var(--muted)">${studentsCache.length ? 'No student matches your filters.' : 'No students yet.'}</td></tr>`;
}

async function removeStudent(studentId) {
  const st = studentsCache.find((x) => x.id === studentId);
  if (!confirm(`Remove ${st ? st.name : 'this student'} from your students?\n\nThey are removed from all your classes, and their attendance, quiz results and proctoring images with you are deleted. Their account and their data with other teachers are not affected.\n\nThe admin can restore this from Restore Data.`)) return;
  try {
    await api(`/teacher/students/${studentId}`, { method: 'DELETE' });
    toast('Student removed');
    quizzesCache = [];
    loadStudents();
  } catch (e) { alert(e.message); }
}

async function resetStudentPw(studentId) {
  if (!confirm('Generate a new temporary password for this student?')) return;
  try {
    const data = await api(`/teacher/students/${studentId}/reset-password`, { method: 'POST' });
    alert(`New temporary password: ${data.temporaryPassword}\n\nShare it with the student — they'll be asked to change it on next login.`);
    loadStudents();
  } catch (e) { alert(e.message); }
}

function classCheckboxes(containerId) {
  document.getElementById(containerId).innerHTML = classesCache.map((c) => `
    <label class="check-item"><input type="checkbox" value="${c.id}" /> ${escapeHtml(c.name)}</label>
  `).join('') || '<span style="color:var(--muted);font-size:13px">You have no classes yet — create one in the Classes tab.</span>';
}

// ---- Add Student: pick students already in my college, or enter a new one ----
// The college (and the roll number, e.g. JIIT12) are filled in automatically.
let addMode = 'pick';
let pickCache = [];           // students of my college that are not mine yet
const pickSelected = new Set(); // ids ticked in the pick list (kept while searching)
let myCollege = { name: '', short: '' };

async function openAddStudent() {
  document.getElementById('addStudentForm').reset();
  document.getElementById('modalAddStudent').style.display = 'flex';
  document.getElementById('addStudentForm').style.display = 'block';
  document.getElementById('studentCredsResult').innerHTML = '';
  document.getElementById('addStudentError').textContent = '';
  pickSelected.clear();
  document.getElementById('sPickList').innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 10px;margin:0">Loading…</p>';
  const [profile, classes, pool] = await Promise.all([api('/teacher/me'), api('/teacher/classes'), api('/teacher/college-students')]);
  myDepartments = profile.departments || [];
  myCollege = { name: profile.collegeName || '', short: profile.collegeShort || '' };
  classesCache = classes;
  pickCache = pool;
  document.getElementById('sCollegeNote').innerHTML = myCollege.name
    ? `College: <b>${escapeHtml(myCollege.name)}</b> — added automatically.`
    : '';
  // A teacher can only put a new student in one of their own domains
  // (an old account with no domain set can pick any).
  const options = myDepartments.length ? myDepartments : ['CSE', 'IT', 'ECE', 'CIVIL'];
  document.getElementById('sDept').innerHTML = options.map((d) => `<option value="${d}">${d}</option>`).join('');
  document.getElementById('sMyDomains').textContent = myDepartments.length ? `(${myDepartments.join(', ')})` : '(no domain set on your account)';
  document.getElementById('sRollHint').textContent = myCollege.short
    ? `Roll number is generated automatically (${myCollege.short}1, ${myCollege.short}2 …).`
    : 'Roll number is generated automatically.';
  classCheckboxes('sClassList');
  refreshStudentClassUi();
  // open on "select existing" when there is someone to pick, otherwise on "new"
  setAddMode(pickCache.length ? 'pick' : 'new');
  renderPickList();
}

function setAddMode(mode) {
  addMode = mode;
  document.querySelectorAll('#sModeTabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('sPickBox').style.display = mode === 'pick' ? 'block' : 'none';
  document.getElementById('sNewBox').style.display = mode === 'new' ? 'block' : 'none';
  // only the visible fields are required
  document.getElementById('sName').required = mode === 'new';
  document.getElementById('sEmail').required = mode === 'new';
  document.getElementById('addStudentError').textContent = '';
  updateSubmitLabel();
  if (mode === 'pick') setTimeout(() => document.getElementById('sPickSearch').focus(), 0);
}
document.querySelectorAll('#sModeTabs button').forEach((b) => b.addEventListener('click', () => setAddMode(b.dataset.mode)));

function updateSubmitLabel() {
  const btn = document.getElementById('sSubmitBtn');
  if (addMode === 'new') { btn.textContent = 'Create student account'; return; }
  const n = pickSelected.size;
  btn.textContent = n ? `Add ${n} selected student${n === 1 ? '' : 's'}` : 'Add selected student(s)';
}

function renderPickList() {
  const q = document.getElementById('sPickSearch').value.trim().toLowerCase();
  const list = !q ? pickCache : pickCache.filter((s) =>
    String(s.name).toLowerCase().includes(q) || String(s.rollNumber).toLowerCase().includes(q));
  const box = document.getElementById('sPickList');
  if (!pickCache.length) {
    box.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 10px;margin:0">There are no other students in your college yet. Use <b>Enter new student details</b> to create one.</p>';
  } else if (!list.length) {
    box.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 10px;margin:0">No student matches your search.</p>';
  } else {
    box.innerHTML = list.map((s) => `
      <label class="pick-row">
        <input type="checkbox" value="${s.id}" ${pickSelected.has(s.id) ? 'checked' : ''} />
        <div class="pick-main">
          <div><b>${escapeHtml(s.name)}</b> &nbsp;<code>${escapeHtml(s.rollNumber || '-')}</code>${s.status === 'suspended' ? ' <span class="badge danger">suspended</span>' : ''}</div>
          <div class="pick-sub">${escapeHtml(s.email)} · ${escapeHtml(s.department || 'no domain')} · added by ${escapeHtml(s.addedBy)}</div>
        </div>
      </label>`).join('');
    box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) pickSelected.add(cb.value); else pickSelected.delete(cb.value);
      updatePickCount();
    }));
  }
  updatePickCount(list.length);
}

function updatePickCount(shown) {
  const total = pickCache.length;
  const showing = shown === undefined ? '' : `Showing ${shown} of ${total} student(s) of your college that you don't have yet.`;
  document.getElementById('sPickCount').textContent = `${showing}${pickSelected.size ? ` ${pickSelected.size} selected.` : ''}`.trim();
  updateSubmitLabel();
}
document.getElementById('sPickSearch').addEventListener('input', renderPickList);

function refreshStudentClassUi() {
  const mode = document.querySelector('input[name="sClassMode"]:checked').value;
  document.getElementById('sClassPicker').style.display = mode === 'selected' ? 'block' : 'none';
}
document.querySelectorAll('input[name="sClassMode"]').forEach((r) => r.addEventListener('change', refreshStudentClassUi));

document.getElementById('addStudentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('addStudentError');
  err.textContent = '';
  const classMode = document.querySelector('input[name="sClassMode"]:checked').value;
  const classIds = [...document.querySelectorAll('#sClassList input:checked')].map((c) => c.value);
  if (classMode === 'selected' && !classIds.length) { err.textContent = 'Select at least one class.'; return; }
  if (classMode === 'all' && !classesCache.length) { err.textContent = 'You have no classes yet.'; return; }
  const assignMode = document.querySelector('input[name="sAssign"]:checked').value;

  if (addMode === 'pick') {
    if (!pickSelected.size) { err.textContent = 'Select at least one student (use the search box to find them).'; return; }
    try {
      const r = await api('/teacher/students/link', { method: 'POST', body: { studentIds: [...pickSelected], assignMode, classMode, classIds } });
      closeModal('modalAddStudent');
      toast(`Added ${r.studentsAdded} student(s)${r.classesJoined ? ` · ${r.classesJoined} class membership(s)` : ''}`);
      loadStudents();
    } catch (e2) { err.textContent = e2.message; }
    return;
  }

  const body = {
    name: document.getElementById('sName').value.trim(),
    email: document.getElementById('sEmail').value.trim(),
    department: document.getElementById('sDept').value,
    assignMode,
    classMode,
    classIds
  };
  try {
    const data = await api('/teacher/students', { method: 'POST', body });
    document.getElementById('addStudentForm').style.display = 'none';
    document.getElementById('studentCredsResult').innerHTML = `
      <p style="font-size:13px;color:var(--muted)">Student created! Share these credentials with them:</p>
      <div class="credential-box">
        Login ID: ${escapeHtml(data.credentials.loginId)}<br/>
        Temporary password: ${escapeHtml(data.credentials.temporaryPassword)}<br/>
        Email: ${escapeHtml(data.credentials.email)}<br/>
        Roll number: ${escapeHtml(data.student.rollNumber)} &nbsp;•&nbsp; Domain: ${escapeHtml(data.student.department)}<br/>
        College: ${escapeHtml(data.student.collegeName)}
      </div>
      <p style="font-size:13px;color:var(--muted)">Added to ${data.teachersAssigned} teacher(s) and ${data.classesJoined} of your class(es).</p>
      <button class="btn full" style="margin-top:14px" onclick="closeModal('modalAddStudent'); loadStudents();">Done</button>
    `;
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// Add an existing student to one / several / all of my classes
function openStudentClasses(studentId) {
  const s = studentsCache.find((x) => x.id === studentId);
  scStudentId = studentId;
  document.getElementById('scStudentName').textContent = s ? `${s.name} (Roll ${s.rollNumber || '-'})` : '';
  document.getElementById('scError').textContent = '';
  document.querySelector('input[name="scMode"][value="selected"]').checked = true;
  document.getElementById('scClassList').innerHTML = classesCache.map((c) => {
    const already = (s?.classIds || []).includes(c.id);
    return `<label class="check-item"><input type="checkbox" value="${c.id}" ${already ? 'checked disabled' : ''} /> ${escapeHtml(c.name)} ${already ? '<small>(already in)</small>' : ''}</label>`;
  }).join('') || '<span style="color:var(--muted);font-size:13px">You have no classes yet — create one in the Classes tab.</span>';
  refreshScUi();
  document.getElementById('modalStudentClasses').style.display = 'flex';
}
function refreshScUi() {
  const mode = document.querySelector('input[name="scMode"]:checked').value;
  document.getElementById('scPicker').style.display = mode === 'selected' ? 'block' : 'none';
}
document.querySelectorAll('input[name="scMode"]').forEach((r) => r.addEventListener('change', refreshScUi));

async function saveStudentClasses() {
  const err = document.getElementById('scError');
  err.textContent = '';
  const mode = document.querySelector('input[name="scMode"]:checked').value;
  const classIds = [...document.querySelectorAll('#scClassList input:checked:not(:disabled)')].map((c) => c.value);
  if (mode === 'selected' && !classIds.length) { err.textContent = 'Select at least one class.'; return; }
  try {
    const r = await api(`/teacher/students/${scStudentId}/classes`, { method: 'POST', body: { mode, classIds } });
    closeModal('modalStudentClasses');
    toast(r.added ? `Added to ${r.added} class(es)` : 'Already in those classes');
    loadStudents();
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------------- Quizzes ----------------------------------------------
async function loadQuizzes() {
  [quizzesCache, classesCache] = await Promise.all([api('/teacher/quizzes'), api('/teacher/classes')]);
  fillClassFilter('quizClassFilter');
  ['quizSearch', 'quizClassFilter', 'quizStatusFilter'].forEach((id) => {
    const el = document.getElementById(id);
    el.oninput = renderQuizzes; el.onchange = renderQuizzes;
  });
  renderQuizzes();
}

function renderQuizzes() {
  const q = lc(document.getElementById('quizSearch').value.trim());
  const cf = document.getElementById('quizClassFilter').value;
  const sf = document.getElementById('quizStatusFilter').value;
  const list = quizzesCache
    .filter((x) => !q || lc(x.title).includes(q))
    .filter((x) => !cf || x.classId === cf)
    .filter((x) => !sf || (sf === 'published' ? x.published : !x.published))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  document.getElementById('quizCount').textContent = `Showing ${list.length} of ${quizzesCache.length} quiz(zes)`;
  document.getElementById('quizRows').innerHTML = list.map((x) => `<tr>
      <td><b>${escapeHtml(x.title)}</b></td>
      <td>${escapeHtml(classNameOf(x.classId) || '-')}</td>
      <td>${x.questions.length}</td>
      <td>${x.durationMinutes} min</td>
      <td><span class="badge ${x.published ? 'ok' : 'muted'}">${x.published ? 'Published' : 'Draft'}</span></td>
      <td class="actions">
        <button class="btn ghost" onclick="openEditQuiz('${x.id}')">Edit</button>
        <button class="btn ghost" onclick="togglePublish('${x.id}', ${x.published})">${x.published ? 'Unpublish' : 'Publish'}</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="deleteQuiz('${x.id}')">Delete</button>
      </td>
    </tr>`).join('') || `<tr><td colspan="6" style="color:var(--muted)">${quizzesCache.length ? 'No quiz matches your filters.' : 'No quizzes yet.'}</td></tr>`;
}

async function togglePublish(id, currentlyPublished) {
  await api(`/teacher/quizzes/${id}`, { method: 'PATCH', body: { published: !currentlyPublished } });
  loadQuizzes();
}
async function deleteQuiz(id) {
  if (!confirm('Delete this quiz permanently?')) return;
  await api(`/teacher/quizzes/${id}`, { method: 'DELETE' });
  loadQuizzes();
}

// ---- Quiz form (used for both "New Quiz" and "Edit Quiz") ------------------
let editingQuizId = null; // null = creating a new quiz
let qUid = 0;

function setQuizModalMode(editing) {
  document.getElementById('quizModalTitle').textContent = editing ? 'Edit Quiz' : 'New Quiz';
  document.getElementById('btnPublishQuiz').style.display = editing ? 'none' : '';
  document.getElementById('btnDraftQuiz').style.display = editing ? 'none' : '';
  document.getElementById('btnSaveEdit').style.display = editing ? '' : 'none';
  const w = document.getElementById('editQuizWarning');
  w.style.display = 'none';
  w.textContent = '';
  document.getElementById('newQuizError').textContent = '';
}

async function fillClassSelect() {
  if (!classesCache.length) classesCache = await api('/teacher/classes');
  document.getElementById('qClass').innerHTML = classesCache
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

async function openNewQuiz() {
  editingQuizId = null;
  await fillClassSelect();
  setQuizModalMode(false);
  ['qTitle', 'qDesc', 'qStart', 'qEnd'].forEach((id) => (document.getElementById(id).value = ''));
  document.getElementById('qDuration').value = 30;
  document.getElementById('qNegative').value = 'false';
  document.getElementById('qLookAway').value = 'medium';
  document.getElementById('questionsContainer').innerHTML = '';
  questionCount = 0;
  addQuestionBlock();
  document.getElementById('modalNewQuiz').style.display = 'flex';
}

// stored datetimes may be "YYYY-MM-DDTHH:mm" (as typed) or full ISO - make them fit <input type=datetime-local>
function toLocalInput(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openEditQuiz(quizId) {
  let quiz;
  try {
    quiz = await api(`/teacher/quizzes/${quizId}`);
  } catch (e) {
    alert(e.message);
    return;
  }
  editingQuizId = quizId;
  await fillClassSelect();
  setQuizModalMode(true);

  document.getElementById('qClass').value = quiz.classId;
  document.getElementById('qTitle').value = quiz.title || '';
  document.getElementById('qDesc').value = quiz.description || '';
  document.getElementById('qDuration').value = quiz.durationMinutes || 30;
  document.getElementById('qNegative').value = quiz.negativeMarking ? 'true' : 'false';
  document.getElementById('qLookAway').value = quiz.lookAwayStrictness || 'medium';
  document.getElementById('qStart').value = toLocalInput(quiz.startTime);
  document.getElementById('qEnd').value = toLocalInput(quiz.endTime);

  const container = document.getElementById('questionsContainer');
  container.innerHTML = '';
  questionCount = 0;
  quiz.questions.forEach((q) => addQuestionBlock(q));

  // warn if students have already started / finished this quiz
  try {
    const attempts = await api(`/teacher/quizzes/${quizId}/results`);
    if (attempts.length) {
      const w = document.getElementById('editQuizWarning');
      w.textContent = `${attempts.length} student(s) have already started or attempted this quiz. Your changes apply to the quiz from now on; scores that were already calculated are not changed.`;
      w.style.display = 'block';
    }
  } catch (e) { /* warning is optional */ }

  document.getElementById('modalNewQuiz').style.display = 'flex';
}

function renumberQuestions() {
  document.querySelectorAll('#questionsContainer .question-block').forEach((b, i) => {
    b.querySelector('.q-num').textContent = `Question ${i + 1}`;
  });
}

// q = existing question (edit mode) or null for a blank one
function addQuestionBlock(q = null) {
  questionCount++;
  const uid = ++qUid;
  const div = document.createElement('div');
  div.className = 'question-block';
  if (q?.id) div.dataset.qid = q.id;
  div.innerHTML = `
    <div class="row between">
      <b class="q-num">Question</b>
      <div class="row">
        <select class="q-type" style="width:auto">
          <option value="mcq">4 options (multiple choice)</option>
          <option value="direct">Direct answer (no options)</option>
        </select>
        <button class="btn ghost q-remove" type="button">Remove</button>
      </div>
    </div>
    <textarea rows="2" placeholder="Question text" class="q-text"></textarea>
    <div class="q-mcq">
      ${[0, 1, 2, 3].map((i) => `
        <div class="option-row">
          <input type="radio" name="correct-${uid}" value="${i}" ${i === 0 ? 'checked' : ''} class="q-correct" />
          <input type="text" placeholder="Option ${i + 1}" class="q-option" />
        </div>`).join('')}
      <small style="color:var(--muted)">Select the radio button next to the correct option.</small>
    </div>
    <div class="q-direct" style="display:none">
      <label>Correct answer</label>
      <input type="text" class="q-answer" placeholder="e.g. 4" />
      <small style="color:var(--muted)">Students type their answer. Matching ignores upper/lower case and extra spaces. To accept several answers, separate them with | (e.g. four|4).</small>
    </div>
    <label style="margin-top:4px">Marks</label>
    <input type="number" class="q-marks" value="1" min="0" step="any" style="max-width:100px" />
  `;

  const typeSel = div.querySelector('.q-type');
  const applyType = () => {
    const direct = typeSel.value === 'direct';
    div.querySelector('.q-mcq').style.display = direct ? 'none' : '';
    div.querySelector('.q-direct').style.display = direct ? '' : 'none';
  };
  typeSel.addEventListener('change', applyType);
  div.querySelector('.q-remove').addEventListener('click', () => { div.remove(); renumberQuestions(); });

  if (q) {
    typeSel.value = q.type === 'direct' ? 'direct' : 'mcq';
    div.querySelector('.q-text').value = q.text || '';
    div.querySelector('.q-marks').value = q.marks || 1;
    if (q.type === 'direct') {
      div.querySelector('.q-answer').value = q.correctAnswer || '';
    } else {
      const opts = div.querySelectorAll('.q-option');
      (q.options || []).slice(0, 4).forEach((o, i) => (opts[i].value = o));
      const radios = div.querySelectorAll('.q-correct');
      if (radios[q.correctIndex]) radios[q.correctIndex].checked = true;
    }
  }
  applyType();
  document.getElementById('questionsContainer').appendChild(div);
  renumberQuestions();
}

// Reads the whole form. Returns { data } or { error }.
function collectQuizForm() {
  const classId = document.getElementById('qClass').value;
  const title = document.getElementById('qTitle').value.trim();
  if (!title || !classId) return { error: 'Please fill a title and pick a class.' };

  const questions = [];
  const blocks = [...document.querySelectorAll('#questionsContainer .question-block')];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const type = b.querySelector('.q-type').value;
    const text = b.querySelector('.q-text').value.trim();
    const marks = Number(b.querySelector('.q-marks').value) || 1;
    const q = { type, text, marks };
    if (b.dataset.qid) q.id = b.dataset.qid;

    if (type === 'direct') {
      q.correctAnswer = b.querySelector('.q-answer').value.trim();
      if (!text && !q.correctAnswer && !b.dataset.qid) continue; // untouched blank block - ignore
      if (!text) return { error: `Question ${i + 1}: enter the question text.` };
      if (!q.correctAnswer) return { error: `Question ${i + 1}: enter the correct answer.` };
    } else {
      q.options = [...b.querySelectorAll('.q-option')].map((o) => o.value.trim());
      q.correctIndex = Number(b.querySelector('.q-correct:checked')?.value ?? 0);
      if (!text && q.options.every((o) => !o) && !b.dataset.qid) continue; // untouched blank block - ignore
      if (!text) return { error: `Question ${i + 1}: enter the question text.` };
      if (q.options.some((o) => !o)) return { error: `Question ${i + 1}: fill in all 4 options.` };
    }
    questions.push(q);
  }
  if (!questions.length) return { error: 'Add at least one complete question.' };

  return {
    data: {
      classId,
      title,
      description: document.getElementById('qDesc').value.trim(),
      durationMinutes: Number(document.getElementById('qDuration').value) || 30,
      negativeMarking: document.getElementById('qNegative').value === 'true',
      lookAwayStrictness: document.getElementById('qLookAway').value,
      startTime: document.getElementById('qStart').value || null,
      endTime: document.getElementById('qEnd').value || null,
      questions
    }
  };
}

// publish=true -> quiz goes live immediately; false -> saved as a draft
async function createQuiz(publish) {
  const err = document.getElementById('newQuizError');
  err.textContent = '';
  const { data, error } = collectQuizForm();
  if (error) { err.textContent = error; return; }
  try {
    await api('/teacher/quizzes', { method: 'POST', body: { ...data, published: !!publish } });
    closeModal('modalNewQuiz');
    loadQuizzes();
  } catch (e) {
    err.textContent = e.message;
  }
}

// edit mode: saves every field; publish/draft status is left as it is
async function saveQuizEdit() {
  const err = document.getElementById('newQuizError');
  err.textContent = '';
  const { data, error } = collectQuizForm();
  if (error) { err.textContent = error; return; }
  try {
    await api(`/teacher/quizzes/${editingQuizId}`, { method: 'PATCH', body: data });
    closeModal('modalNewQuiz');
    loadQuizzes();
  } catch (e) {
    err.textContent = e.message;
  }
}

// ---------------- Results ----------------------------------------------
let resultsCache = [];
async function loadResultsView() {
  [quizzesCache, classesCache] = await Promise.all([api('/teacher/quizzes'), api('/teacher/classes')]);
  fillClassFilter('resClass');
  document.getElementById('resClass').onchange = fillResultQuizzes;
  document.getElementById('resultsQuizSelect').onchange = () => loadResults(document.getElementById('resultsQuizSelect').value);
  document.getElementById('resSearch').oninput = renderResults;
  fillResultQuizzes();
}
function fillResultQuizzes() {
  const cf = document.getElementById('resClass').value;
  const sel = document.getElementById('resultsQuizSelect');
  const list = quizzesCache.filter((q) => !cf || q.classId === cf);
  sel.innerHTML = list.map((q) => `<option value="${q.id}">${escapeHtml(q.title)}${cf ? '' : ` — ${escapeHtml(classNameOf(q.classId))}`}</option>`).join('');
  if (list.length) loadResults(sel.value);
  else {
    resultsCache = [];
    document.getElementById('resSummary').innerHTML = '';
    document.getElementById('resultRows').innerHTML = `<tr><td colspan="7" style="color:var(--muted)">${quizzesCache.length ? 'No quizzes in this class.' : 'No quizzes yet.'}</td></tr>`;
  }
}
async function loadResults(quizId) {
  resultsCache = (await api(`/teacher/quizzes/${quizId}/results`)).sort(byRoll);
  renderResults();
}
function renderResults() {
  const q = lc(document.getElementById('resSearch').value.trim());
  const rows = resultsCache.filter((r) => !q || lc(r.studentName).includes(q) || lc(r.studentRoll).includes(q));
  const done = resultsCache.filter((r) => r.status !== 'in-progress' && r.totalMarks);
  const pct = done.map((r) => (r.score / r.totalMarks) * 100);
  const avg = pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length) : null;
  document.getElementById('resSummary').innerHTML = resultsCache.length ? `
    <div class="summary-pill"><b>${resultsCache.length}</b>attempts</div>
    <div class="summary-pill ok"><b>${avg === null ? '-' : avg + '%'}</b>average</div>
    <div class="summary-pill"><b>${pct.length ? Math.round(Math.max(...pct)) + '%' : '-'}</b>highest</div>
    <div class="summary-pill"><b>${pct.length ? Math.round(Math.min(...pct)) + '%' : '-'}</b>lowest</div>
    <div class="summary-pill warn"><b>${resultsCache.filter((r) => r.status === 'auto-submitted').length}</b>auto-submitted</div>` : '';
  document.getElementById('resultRows').innerHTML = rows.map((r) => `
    <tr class="rv-row" data-review="/teacher/attempts/${encodeURIComponent(r.id)}/review" tabindex="0" title="See this student's answers">
      <td>${escapeHtml(r.studentName || r.studentId)} <span class="rv-row-hint">View answers</span></td>
      <td><b>${escapeHtml(r.studentRoll || '-')}</b></td>
      <td>${r.score ?? '-'} / ${r.totalMarks}</td>
      <td><span class="badge ${r.status === 'submitted' ? 'ok' : r.status === 'auto-submitted' ? 'warn' : 'muted'}">${escapeHtml(r.status)}</span></td>
      <td>${r.tabSwitches || 0}</td>
      <td>${r.fullscreenExits || 0}</td>
      <td>${r.alertCount || 0}</td>
    </tr>
  `).join('') || `<tr><td colspan="7" style="color:var(--muted)">${resultsCache.length ? 'No student matches your search.' : 'No attempts yet.'}</td></tr>`;
}

// ---------------- Attendance ----------------------------------------------
let attHistoryCache = [];
async function loadAttendanceView() {
  [classesCache, studentsCache] = await Promise.all([api('/teacher/classes'), api('/teacher/students')]);
  fillClassFilter('attClassSelect', '');
  const dateEl = document.getElementById('attDate');
  if (!dateEl.value) dateEl.value = todayLocal();
  dateEl.max = todayLocal();
  document.getElementById('attClassSelect').onchange = onAttClassChange;
  dateEl.onchange = renderAttendanceSheet;
  ['attFrom', 'attTo', 'attStatusFilter', 'attSearch'].forEach((id) => {
    const el = document.getElementById(id);
    el.oninput = renderAttendanceHistory; el.onchange = renderAttendanceHistory;
  });
  if (classesCache.length) onAttClassChange();
  else {
    document.getElementById('attRows').innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Create a class first.</td></tr>';
    document.getElementById('attHistoryRows').innerHTML = '';
  }
}
async function onAttClassChange() {
  const classId = document.getElementById('attClassSelect').value;
  document.getElementById('attHistClass').textContent = classNameOf(classId) ? `— ${classNameOf(classId)}` : '';
  attHistoryCache = await api(`/teacher/attendance?classId=${classId}`);
  renderAttendanceSheet();
  renderAttendanceHistory();
}
// kept for older buttons/links
function loadAttendanceSheet() { onAttClassChange(); }

// The sheet lists the class's current students by roll number. If attendance
// was already saved for that date, it is pre-filled and saving again updates it.
function renderAttendanceSheet() {
  const classId = document.getElementById('attClassSelect').value;
  const date = document.getElementById('attDate').value;
  const cls = classesCache.find((c) => c.id === classId);
  const students = studentsCache.filter((s) => cls?.studentIds.includes(s.id)).sort(byRoll);
  const saved = Object.fromEntries(attHistoryCache.filter((r) => r.date === date).map((r) => [r.studentId, r.status]));
  document.getElementById('attSheetHint').textContent = Object.keys(saved).length
    ? `Attendance for ${date} is already saved — change anything and save again to update it.`
    : '';
  document.getElementById('attRows').innerHTML = students.map((s) => {
    const st = saved[s.id] || 'present';
    return `<tr class="${st === 'absent' ? 'att-absent' : ''}">
      <td class="att-check-cell"><input type="checkbox" class="att-check" data-student="${s.id}" ${st !== 'absent' ? 'checked' : ''} aria-label="${escapeHtml(s.name)} attended" /></td>
      <td><b>${escapeHtml(s.rollNumber || '-')}</b></td>
      <td>${escapeHtml(s.name)}</td>
      <td>
        <select data-student="${s.id}" class="att-status">
          <option value="present" ${st === 'present' ? 'selected' : ''}>Present</option>
          <option value="absent" ${st === 'absent' ? 'selected' : ''}>Absent</option>
          <option value="late" ${st === 'late' ? 'selected' : ''}>Late</option>
        </select>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="color:var(--muted)">No students enrolled in this class.</td></tr>';
  syncAttChecks();
}
function markAll(status) {
  document.querySelectorAll('.att-status').forEach((sel) => { sel.value = status; });
  syncAttChecks();
}
// Checkbox on the left of each student: ticked = attended (Present or Late),
// unticked = Absent. It stays in step with the Status dropdown both ways.
function syncAttChecks() {
  const sels = [...document.querySelectorAll('.att-status')];
  sels.forEach((sel) => {
    const box = document.querySelector(`.att-check[data-student="${sel.dataset.student}"]`);
    if (box) box.checked = sel.value !== 'absent';
    sel.closest('tr')?.classList.toggle('att-absent', sel.value === 'absent');
  });
  const all = document.getElementById('attCheckAll');
  if (all) {
    const on = sels.filter((sel) => sel.value !== 'absent').length;
    all.checked = sels.length > 0 && on === sels.length;
    all.indeterminate = on > 0 && on < sels.length;
    all.disabled = sels.length === 0;
  }
}
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.classList?.contains('att-check')) {
    const sel = document.querySelector(`.att-status[data-student="${t.dataset.student}"]`);
    if (sel) sel.value = t.checked ? (sel.value === 'absent' ? 'present' : sel.value) : 'absent';
    syncAttChecks();
  } else if (t.classList?.contains('att-status')) {
    syncAttChecks();
  } else if (t.id === 'attCheckAll') {
    markAll(t.checked ? 'present' : 'absent');
  }
});
async function submitAttendance() {
  const classId = document.getElementById('attClassSelect').value;
  const date = document.getElementById('attDate').value;
  if (!classId) { alert('Choose a class.'); return; }
  if (!date) { alert('Choose a date.'); return; }
  const records = [...document.querySelectorAll('.att-status')].map((sel) => ({
    studentId: sel.dataset.student, status: sel.value
  }));
  if (!records.length) { alert('No students in this class.'); return; }
  try {
    await api('/teacher/attendance', { method: 'POST', body: { classId, date, records } });
    toast('Attendance saved');
    onAttClassChange();
  } catch (e) { alert(e.message); }
}
async function loadAttendanceHistory() { onAttClassChange(); }
function clearAttFilters() {
  ['attFrom', 'attTo', 'attStatusFilter', 'attSearch'].forEach((id) => { document.getElementById(id).value = ''; });
  renderAttendanceHistory();
}
function renderAttendanceHistory() {
  const from = document.getElementById('attFrom').value;
  const to = document.getElementById('attTo').value;
  const sf = document.getElementById('attStatusFilter').value;
  const q = lc(document.getElementById('attSearch').value.trim());
  const rows = attHistoryCache
    .filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    .filter((r) => !sf || r.status === sf)
    .filter((r) => !q || lc(r.studentName).includes(q) || lc(r.studentRoll).includes(q));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const days = new Set(rows.map((r) => r.date)).size;
  document.getElementById('attSummary').innerHTML = rows.length ? `
    <div class="summary-pill"><b>${days}</b>day(s)</div>
    <div class="summary-pill ok"><b>${count('present')}</b>present</div>
    <div class="summary-pill warn"><b>${count('late')}</b>late</div>
    <div class="summary-pill danger"><b>${count('absent')}</b>absent</div>
    <div class="summary-pill"><b>${Math.round(((count('present') + count('late')) / rows.length) * 100)}%</b>attendance</div>` : '';
  const badge = (s) => `<span class="badge ${s === 'present' ? 'ok' : s === 'late' ? 'warn' : 'danger'}">${escapeHtml(s)}</span>`;
  document.getElementById('attHistoryRows').innerHTML = rows.map((r) => `
    <tr><td>${escapeHtml(r.date)}</td><td><b>${escapeHtml(r.studentRoll || '-')}</b></td><td>${escapeHtml(r.studentName)}</td><td>${badge(r.status)}</td></tr>
  `).join('') || `<tr><td colspan="4" style="color:var(--muted)">${attHistoryCache.length ? 'No records match your filters.' : 'No attendance recorded yet.'}</td></tr>`;
}

// ---------------- Proctoring reports (view only — detection is unchanged) -----------
let prCache = [];
async function loadProctoringView() {
  [quizzesCache, classesCache] = await Promise.all([api('/teacher/quizzes'), api('/teacher/classes')]);
  fillClassFilter('prClass');
  document.getElementById('prClass').onchange = () => { fillProctorQuizzes(); renderProctorEvents(); };
  document.getElementById('proctorQuizSelect').onchange = renderProctorEvents;
  document.getElementById('prType').onchange = renderProctorEvents;
  document.getElementById('prSearch').oninput = renderProctorEvents;
  fillProctorQuizzes();
  loadProctorEvents();
}
function fillProctorQuizzes() {
  const cf = document.getElementById('prClass').value;
  const sel = document.getElementById('proctorQuizSelect');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All quizzes</option>' + quizzesCache
    .filter((q) => !cf || q.classId === cf)
    .map((q) => `<option value="${q.id}">${escapeHtml(q.title)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
async function loadProctorEvents() {
  prCache = await api('/teacher/proctoring/events');
  const typeSel = document.getElementById('prType');
  const keep = typeSel.value;
  const types = [...new Set(prCache.map((e) => e.type))].sort();
  typeSel.innerHTML = '<option value="">All events</option>' + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t.replace(/_/g, ' '))}</option>`).join('');
  if (types.includes(keep)) typeSel.value = keep;
  renderProctorEvents();
}
function renderProctorEvents() {
  const cf = document.getElementById('prClass').value;
  const qf = document.getElementById('proctorQuizSelect').value;
  const tf = document.getElementById('prType').value;
  const q = lc(document.getElementById('prSearch').value.trim());
  const events = prCache
    .filter((e) => (!cf || e.classId === cf) && (!qf || e.quizId === qf) && (!tf || e.type === tf))
    .filter((e) => !q || [e.studentName, e.studentRoll, e.quizTitle, e.className].some((v) => lc(v).includes(q)));
  const high = events.filter((e) => severityClass(e.type) === 'danger').length;
  document.getElementById('prSummary').innerHTML = prCache.length ? `
    <div class="summary-pill"><b>${events.length}</b>alerts</div>
    <div class="summary-pill danger"><b>${high}</b>high severity</div>
    <div class="summary-pill"><b>${new Set(events.map((e) => e.studentId)).size}</b>students flagged</div>
    <div class="summary-pill"><b>${events.filter((e) => e.evidenceFile).length}</b>with image</div>` : '';
  document.getElementById('proctorRows').innerHTML = events.map((ev) => `
    <tr>
      <td>${fmtDate(ev.timestamp)}</td>
      <td>${escapeHtml(ev.studentName || ev.studentId)}</td>
      <td><b>${escapeHtml(ev.studentRoll || '-')}</b></td>
      <td>${escapeHtml(ev.className || '-')}</td>
      <td>${escapeHtml(ev.quizTitle || '-')}</td>
      <td><span class="badge ${severityClass(ev.type)}">${escapeHtml(ev.type.replace(/_/g, ' '))}</span></td>
      <td>${ev.confidence ? Math.round(ev.confidence * 100) + '%' : '-'}</td>
      <td>${ev.evidenceFile ? `<a href="#" onclick="viewEvidence('${ev.evidenceFile}');return false;">View</a> &nbsp;|&nbsp; <a href="#" style="color:var(--danger)" onclick="deleteEvidenceImage('${ev.id}');return false;">Delete image</a>` : '-'}</td>
    </tr>
  `).join('') || `<tr><td colspan="8" style="color:var(--muted)">${prCache.length ? 'No alerts match your filters.' : 'No proctoring alerts recorded.'}</td></tr>`;
}
async function deleteEvidenceImage(eventId) {
  if (!confirm('Delete this proctoring image? The alert stays in the report; only the picture is removed.')) return;
  try {
    await api(`/teacher/proctoring/events/${eventId}/evidence`, { method: 'DELETE' });
    loadProctorEvents();
  } catch (e) { alert(e.message); }
}
function severityClass(type) {
  if (['MULTIPLE_FACES', 'PHONE_DETECTED', 'NO_FACE'].includes(type)) return 'danger';
  if (['TAB_SWITCH', 'FULLSCREEN_EXIT', 'LOOKING_AWAY', 'EYES_CLOSED', 'OBJECT_DETECTED'].includes(type)) return 'warn';
  return 'muted';
}
function viewEvidence(filename) {
  const url = `${window.API_BASE}/api/proctor/evidence/${filename}`;
  fetch(url, { headers: { Authorization: `Bearer ${Session.token}` } })
    .then((r) => r.blob())
    .then((blob) => window.open(URL.createObjectURL(blob), '_blank'));
}

// ---------------- Live monitor ----------------------------------------------
let socket = null;
const liveState = {}; // studentId -> {name, events:[]}

// Quiz picker with class filter + title search. Picking a quiz calls watchQuiz()
// exactly as before; the live socket code below is unchanged.
function fillLiveQuizzes() {
  const cf = document.getElementById('liveClass').value;
  const q = lc(document.getElementById('liveSearch').value.trim());
  const sel = document.getElementById('liveQuizSelect');
  const keep = sel.value;
  const list = quizzesCache.filter((x) => x.published && (!cf || x.classId === cf) && (!q || lc(x.title).includes(q)));
  sel.innerHTML = list.map((x) => `<option value="${x.id}">${escapeHtml(x.title)}${cf ? '' : ` — ${escapeHtml(classNameOf(x.classId))}`}</option>`).join('')
    || '<option value="">No matching published quiz</option>';
  if ([...sel.options].some((o) => o.value === keep && keep)) sel.value = keep;
  return sel.value !== keep;
}
async function loadLiveView() {
  [quizzesCache, classesCache] = await Promise.all([api('/teacher/quizzes'), api('/teacher/classes')]);
  fillClassFilter('liveClass');
  const sel = document.getElementById('liveQuizSelect');
  const refilter = () => {
    if (fillLiveQuizzes()) {
      if (sel.value) watchQuiz(sel.value);
      else { Object.keys(liveState).forEach((k) => delete liveState[k]); renderLiveGrid(); }
    }
  };
  document.getElementById('liveClass').onchange = refilter;
  document.getElementById('liveSearch').oninput = refilter;
  fillLiveQuizzes();
  sel.onchange = () => watchQuiz(sel.value);
  if (!socket) {
    socket = io(window.API_BASE || undefined, { auth: { token: Session.token } });
    socket.on('proctor-event', (ev) => {
      if (!liveState[ev.studentId]) liveState[ev.studentId] = { name: ev.studentName, events: [] };
      liveState[ev.studentId].events.unshift(ev);
      renderLiveGrid();
    });
  }
  if (sel.value) watchQuiz(sel.value);
}
function watchQuiz(quizId) {
  Object.keys(liveState).forEach((k) => delete liveState[k]);
  socket.emit('watch-quiz', quizId);
  renderLiveGrid();
}
function renderLiveGrid() {
  const grid = document.getElementById('liveGrid');
  const ids = Object.keys(liveState);
  if (!ids.length) { grid.innerHTML = '<p style="color:var(--muted)">No alerts yet. Waiting for students to start the quiz...</p>'; return; }
  grid.innerHTML = ids.map((id) => {
    const s = liveState[id];
    const dangerCount = s.events.filter((e) => severityClass(e.type) === 'danger').length;
    return `<div class="live-student">
      <div class="name">${s.name || id} ${dangerCount ? `<span class="badge danger">${dangerCount} high</span>` : ''}</div>
      <div class="events">${s.events.slice(0, 8).map((e) => `${new Date(e.timestamp).toLocaleTimeString()} — ${e.type.replace(/_/g, ' ')}`).join('<br/>')}</div>
    </div>`;
  }).join('');
}

loadClasses();
