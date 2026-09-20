const me = Session.requireRole('teacher');
document.getElementById('whoBox').textContent = `${me.name} (${me.loginId})`;

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

// ---------------- Classes ----------------------------------------------
async function loadClasses() {
  classesCache = await api('/teacher/classes');
  if (!studentsCache.length) studentsCache = await api('/teacher/students');
  const el = document.getElementById('classList');
  el.innerHTML = classesCache.map((c) => `
    <div class="panel">
      <h3>${c.name}</h3>
      <p style="color:var(--muted);font-size:13px">${c.studentIds.length} student(s) enrolled</p>
      <button class="btn ghost" onclick="openEnroll('${c.id}')">Manage students</button>
      <button class="btn ghost" style="color:var(--danger)" onclick="deleteClass('${c.id}')">Delete class</button>
    </div>
  `).join('') || '<p style="color:var(--muted)">No classes yet. Create one to get started.</p>';
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

async function openEnroll(classId) {
  const cls = classesCache.find((c) => c.id === classId);
  const list = document.getElementById('enrollList');
  list.innerHTML = studentsCache.map((s) => {
    const enrolled = cls.studentIds.includes(s.id);
    return `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div>${s.name} <span style="color:var(--muted);font-size:12px">${s.email}</span></div>
      <button class="btn ${enrolled ? 'secondary' : ''}" onclick="toggleEnroll('${classId}','${s.id}', ${enrolled})">
        ${enrolled ? 'Remove' : 'Add'}
      </button>
    </div>`;
  }).join('') || '<p style="color:var(--muted)">No students yet — add some from the Students tab.</p>';
  document.getElementById('modalEnroll').style.display = 'flex';
}

async function toggleEnroll(classId, studentId, currentlyEnrolled) {
  const path = currentlyEnrolled ? `/teacher/classes/${classId}/unenroll` : `/teacher/classes/${classId}/enroll`;
  await api(path, { method: 'POST', body: { studentId } });
  const cls = classesCache.find((c) => c.id === classId);
  if (currentlyEnrolled) cls.studentIds = cls.studentIds.filter((id) => id !== studentId);
  else cls.studentIds.push(studentId);
  openEnroll(classId);
}

// ---------------- Students ----------------------------------------------
let myDepartments = [];
let scStudentId = null;

async function loadStudents() {
  studentsCache = await api('/teacher/students');
  classesCache = await api('/teacher/classes');
  const className = (id) => classesCache.find((c) => c.id === id)?.name;
  document.getElementById('studentRows').innerHTML = studentsCache.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.email)}</td>
      <td><code>${escapeHtml(s.loginId)}</code></td>
      <td>${escapeHtml(s.rollNumber || '-')}</td>
      <td>${escapeHtml(s.department || '-')}</td>
      <td>${escapeHtml((s.classIds || []).map(className).filter(Boolean).join(', ') || '-')}</td>
      <td>
        ${s.resetRequested ? '<span class="badge warn">Reset requested</span>' : ''}
        <button class="btn ghost" onclick="openStudentClasses('${s.id}')">Add to class</button>
        <button class="btn ghost" onclick="resetStudentPw('${s.id}')">Reset password</button>
        <button class="btn ghost" style="color:var(--danger)" onclick="removeStudent('${s.id}')">Remove</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="color:var(--muted)">No students yet.</td></tr>';
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

async function openAddStudent() {
  document.getElementById('addStudentForm').reset();
  document.getElementById('modalAddStudent').style.display = 'flex';
  document.getElementById('addStudentForm').style.display = 'block';
  document.getElementById('studentCredsResult').innerHTML = '';
  document.getElementById('addStudentError').textContent = '';
  const [profile, classes] = await Promise.all([api('/teacher/me'), api('/teacher/classes')]);
  myDepartments = profile.departments || [];
  classesCache = classes;
  // A teacher can only put a student in one of their own domains
  // (an old account with no domain set can pick any).
  const options = myDepartments.length ? myDepartments : ['CSE', 'IT', 'ECE', 'CIVIL'];
  document.getElementById('sDept').innerHTML = options.map((d) => `<option value="${d}">${d}</option>`).join('');
  document.getElementById('sMyDomains').textContent = myDepartments.length ? `(${myDepartments.join(', ')})` : '(no domain set on your account)';
  classCheckboxes('sClassList');
  refreshStudentClassUi();
}

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
  const body = {
    name: document.getElementById('sName').value.trim(),
    email: document.getElementById('sEmail').value.trim(),
    department: document.getElementById('sDept').value,
    assignMode: document.querySelector('input[name="sAssign"]:checked').value,
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
        Roll number: ${escapeHtml(data.student.rollNumber)} &nbsp;•&nbsp; Domain: ${escapeHtml(data.student.department)}
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
  quizzesCache = await api('/teacher/quizzes');
  if (!classesCache.length) classesCache = await api('/teacher/classes');
  document.getElementById('quizRows').innerHTML = quizzesCache.map((q) => {
    const cls = classesCache.find((c) => c.id === q.classId);
    return `<tr>
      <td>${q.title}</td>
      <td>${cls?.name || '-'}</td>
      <td>${q.questions.length}</td>
      <td>${q.durationMinutes} min</td>
      <td><span class="badge ${q.published ? 'ok' : 'muted'}">${q.published ? 'Published' : 'Draft'}</span></td>
      <td>
        <button class="btn ghost" onclick="openEditQuiz('${q.id}')">Edit</button>
        <button class="btn ghost" onclick="togglePublish('${q.id}', ${q.published})">${q.published ? 'Unpublish' : 'Publish'}</button>
        <button class="btn ghost" onclick="deleteQuiz('${q.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="color:var(--muted)">No quizzes yet.</td></tr>';
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
async function loadResultsView() {
  if (!quizzesCache.length) quizzesCache = await api('/teacher/quizzes');
  const sel = document.getElementById('resultsQuizSelect');
  sel.innerHTML = quizzesCache.map((q) => `<option value="${q.id}">${q.title}</option>`).join('');
  sel.onchange = () => loadResults(sel.value);
  if (quizzesCache.length) loadResults(sel.value);
  else document.getElementById('resultRows').innerHTML = '<tr><td colspan="7" style="color:var(--muted)">No quizzes yet.</td></tr>';
}
async function loadResults(quizId) {
  const rows = await api(`/teacher/quizzes/${quizId}/results`);
  document.getElementById('resultRows').innerHTML = rows.map((r) => `
    <tr>
      <td>${r.studentName || r.studentId}</td>
      <td>${r.studentRoll || '-'}</td>
      <td>${r.score ?? '-'} / ${r.totalMarks}</td>
      <td><span class="badge ${r.status === 'submitted' ? 'ok' : r.status === 'auto-submitted' ? 'warn' : 'muted'}">${r.status}</span></td>
      <td>${r.tabSwitches || 0}</td>
      <td>${r.fullscreenExits || 0}</td>
      <td>${r.alertCount || 0}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="color:var(--muted)">No attempts yet.</td></tr>';
}

// ---------------- Attendance ----------------------------------------------
async function loadAttendanceView() {
  if (!classesCache.length) classesCache = await api('/teacher/classes');
  const sel = document.getElementById('attClassSelect');
  sel.innerHTML = classesCache.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('attDate').value = new Date().toISOString().slice(0, 10);
  if (classesCache.length) { loadAttendanceSheet(); loadAttendanceHistory(); }
}
function loadAttendanceSheet() {
  const classId = document.getElementById('attClassSelect').value;
  const cls = classesCache.find((c) => c.id === classId);
  const students = studentsCache.filter((s) => cls?.studentIds.includes(s.id));
  document.getElementById('attRows').innerHTML = students.map((s) => `
    <tr>
      <td>${s.name}</td>
      <td>
        <select data-student="${s.id}" class="att-status">
          <option value="present">Present</option>
          <option value="absent">Absent</option>
          <option value="late">Late</option>
        </select>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="2" style="color:var(--muted)">No students enrolled in this class.</td></tr>';
  loadAttendanceHistory();
}
async function submitAttendance() {
  const classId = document.getElementById('attClassSelect').value;
  const date = document.getElementById('attDate').value;
  const records = [...document.querySelectorAll('.att-status')].map((sel) => ({
    studentId: sel.dataset.student, status: sel.value
  }));
  await api('/teacher/attendance', { method: 'POST', body: { classId, date, records } });
  toast('Attendance saved');
  loadAttendanceHistory();
}
async function loadAttendanceHistory() {
  const classId = document.getElementById('attClassSelect').value;
  const rows = await api(`/teacher/attendance?classId=${classId}`);
  document.getElementById('attHistoryRows').innerHTML = rows.map((r) => {
    const s = studentsCache.find((x) => x.id === r.studentId);
    return `<tr><td>${r.date}</td><td>${s?.name || r.studentId}</td><td>${r.status}</td></tr>`;
  }).join('') || '<tr><td colspan="3" style="color:var(--muted)">No attendance recorded yet.</td></tr>';
}

// ---------------- Proctoring reports ----------------------------------------------
async function loadProctoringView() {
  if (!quizzesCache.length) quizzesCache = await api('/teacher/quizzes');
  const sel = document.getElementById('proctorQuizSelect');
  sel.innerHTML = `<option value="">All quizzes</option>` + quizzesCache.map((q) => `<option value="${q.id}">${q.title}</option>`).join('');
  sel.onchange = () => loadProctorEvents(sel.value);
  loadProctorEvents('');
}
async function loadProctorEvents(quizId) {
  const events = await api(`/teacher/proctoring/events${quizId ? `?quizId=${quizId}` : ''}`);
  document.getElementById('proctorRows').innerHTML = events.map((ev) => `
    <tr>
      <td>${fmtDate(ev.timestamp)}</td>
      <td>${ev.studentName || ev.studentId}</td>
      <td><span class="badge ${severityClass(ev.type)}">${ev.type.replace(/_/g, ' ')}</span></td>
      <td>${ev.confidence ? Math.round(ev.confidence * 100) + '%' : '-'}</td>
      <td>${ev.evidenceFile ? `<a href="#" onclick="viewEvidence('${ev.evidenceFile}');return false;">View</a> &nbsp;|&nbsp; <a href="#" style="color:var(--danger)" onclick="deleteEvidenceImage('${ev.id}');return false;">Delete image</a>` : '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="color:var(--muted)">No proctoring alerts recorded.</td></tr>';
}
async function deleteEvidenceImage(eventId) {
  if (!confirm('Delete this proctoring image? The alert stays in the report; only the picture is removed.')) return;
  try {
    await api(`/teacher/proctoring/events/${eventId}/evidence`, { method: 'DELETE' });
    loadProctorEvents(document.getElementById('proctorQuizSelect').value);
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

async function loadLiveView() {
  if (!quizzesCache.length) quizzesCache = await api('/teacher/quizzes');
  const sel = document.getElementById('liveQuizSelect');
  sel.innerHTML = quizzesCache.filter((q) => q.published).map((q) => `<option value="${q.id}">${q.title}</option>`).join('');
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
