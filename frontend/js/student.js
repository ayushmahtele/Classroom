const me = Session.requireRole('student');
document.getElementById('whoBox').textContent = `${me.name} (${me.loginId})`;
api('/student/profile').then((p) => {
  if (p.collegeName) document.getElementById('whoCollege').textContent = `${p.collegeName}${p.collegeShort ? ` (${p.collegeShort})` : ''}`;
}).catch(() => {});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;
const lc = (v) => String(v ?? '').toLowerCase();

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
function showView(view) {
  document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.main > section').forEach((s) => (s.style.display = 'none'));
  document.getElementById(`view-${view}`).style.display = 'block';
  if (view === 'quizzes') loadQuizzes();
  if (view === 'classes') loadClasses();
  if (view === 'results') loadResults();
  if (view === 'attendance') loadAttendance();
  if (view === 'profile') loadProfile('student');
}

/** Fills a class filter <select> from a list of {classId|id, className|name}. */
function fillClassFilter(selectId, items) {
  const sel = document.getElementById(selectId);
  const keep = sel.value;
  const map = new Map();
  for (const it of items) {
    const id = it.classId || it.id;
    const name = it.className || it.name;
    if (id && name && !map.has(id)) map.set(id, name);
  }
  sel.innerHTML = '<option value="">All classes</option>' +
    [...map].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

// ---- quiz status (state comes from the server) ----
const STATE = {
  available: { label: 'Available', cls: 'ok' },
  'in-progress': { label: 'In progress', cls: 'warn' },
  upcoming: { label: 'Upcoming', cls: 'muted' },
  completed: { label: 'Completed', cls: 'ok' },
  missed: { label: 'Missed', cls: 'danger' }
};
const stateBadge = (s) => `<span class="badge ${STATE[s]?.cls || 'muted'}">${STATE[s]?.label || esc(s)}</span>`;
const fmtWindow = (q) => {
  const parts = [];
  if (q.startTime) parts.push(`Opens ${fmtDate(q.startTime)}`);
  if (q.endTime) parts.push(`Closes ${fmtDate(q.endTime)}`);
  return parts.join(' · ');
};

// =================== My Quizzes ===================
let quizzesCache = [];
let quizChip = '';

async function loadQuizzes() {
  quizzesCache = await api('/student/quizzes');
  fillClassFilter('qClass', quizzesCache);
  document.getElementById('qSearch').oninput = renderQuizzes;
  document.getElementById('qClass').onchange = renderQuizzes;
  renderQuizzes();
}

function renderQuizzes() {
  const q = lc(document.getElementById('qSearch').value.trim());
  const cf = document.getElementById('qClass').value;
  const base = quizzesCache
    .filter((x) => !q || lc(x.title).includes(q) || lc(x.className).includes(q))
    .filter((x) => !cf || x.classId === cf);
  const order = ['', 'available', 'in-progress', 'upcoming', 'completed', 'missed'];
  document.getElementById('quizChips').innerHTML = order.map((s) => {
    const n = s ? base.filter((x) => x.state === s).length : base.length;
    return `<button class="chip ${quizChip === s ? 'active' : ''}" onclick="quizChip='${s}';renderQuizzes()">${s ? STATE[s].label : 'All'}<b>${n}</b></button>`;
  }).join('');
  // things you can do now first, then upcoming, then the rest
  const rank = { 'in-progress': 0, available: 1, upcoming: 2, completed: 3, missed: 4 };
  const list = base.filter((x) => !quizChip || x.state === quizChip).sort((a, b) => rank[a.state] - rank[b.state]);
  document.getElementById('quizList').innerHTML = list.map((x) => `
    <div class="panel">
      <div class="row between" style="flex-wrap:nowrap;align-items:flex-start;gap:8px">
        <h3>${esc(x.title)}</h3>${stateBadge(x.state)}
      </div>
      <div class="meta"><span class="tag">${esc(x.className)}</span><span>👩‍🏫 ${esc(x.teacherName)}</span></div>
      ${x.description ? `<p style="color:var(--muted);font-size:13px;margin:0">${esc(x.description)}</p>` : ''}
      <div class="meta">${x.durationMinutes ? `<span>⏱ ${x.durationMinutes} min</span>` : ''}<span>❓ ${x.questionCount} question(s)</span></div>
      ${fmtWindow(x) ? `<div class="meta">🗓 ${esc(fmtWindow(x))}</div>` : ''}
      ${x.state === 'completed' && x.totalMarks ? `<div class="meta"><span>Score: <b style="color:var(--text)">${x.score} / ${x.totalMarks}</b></span></div>` : ''}
      <div class="card-actions">${actionButton(x)}</div>
    </div>
  `).join('') || `<div class="empty">${quizzesCache.length ? 'No quiz matches your search.' : 'No quizzes assigned yet.'}</div>`;
}

// Same rule as before: Start/Resume only while the quiz window is open and it isn't finished.
function actionButton(q) {
  if (q.attemptStatus === 'submitted' || q.attemptStatus === 'auto-submitted') return '';
  if (!q.windowOpen) return '';
  return `<button class="btn full" onclick="startQuiz('${q.id}')">${q.attemptStatus === 'in-progress' ? 'Resume Quiz' : 'Start Quiz'}</button>`;
}

function startQuiz(quizId) {
  window.location.href = `quiz.html?quizId=${quizId}`;
}

// =================== My Classes ===================
let classesCache = [];

async function loadClasses() {
  document.getElementById('classesHome').style.display = 'block';
  document.getElementById('classDetail').style.display = 'none';
  classesCache = await api('/student/classes');
  document.getElementById('cSearch').oninput = renderClasses;
  renderClasses();
}

function progressBar(c) {
  const t = c.counts.total || 1;
  const w = (n) => `${(n / t) * 100}%`;
  return `<div class="progress" title="completed / missed">
    <span class="p-ok" style="width:${w(c.counts.completed)}"></span>
    <span class="p-danger" style="width:${w(c.counts.missed)}"></span>
  </div>`;
}
const attPercent = (a) => (a.total ? Math.round(((a.present + a.late) / a.total) * 100) : null);

function renderClasses() {
  const q = lc(document.getElementById('cSearch').value.trim());
  const list = classesCache.filter((c) => !q || lc(c.name).includes(q) || lc(c.teacherName).includes(q));
  document.getElementById('classList').innerHTML = list.map((c) => {
    const pending = c.counts.available + c.counts.inProgress;
    const ap = attPercent(c.attendance);
    return `
    <div class="panel clickable" onclick="openClass('${c.id}')" role="button" tabindex="0">
      <h3>${esc(c.name)}</h3>
      <div class="meta"><span>👩‍🏫 ${esc(c.teacherName)}</span><span>👥 ${c.classmates} student(s)</span></div>
      <div class="stat-line">
        <div><b>${c.counts.total}</b>quizzes</div>
        <div><b style="color:var(--ok)">${c.counts.completed}</b>done</div>
        <div><b style="color:var(--danger)">${c.counts.missed}</b>missed</div>
        <div><b style="color:var(--primary)">${pending}</b>to do</div>
      </div>
      ${progressBar(c)}
      <div class="meta">
        <span>Average: <b style="color:var(--text)">${c.averagePercent === null ? '-' : c.averagePercent + '%'}</b></span>
        <span>Attendance: <b style="color:var(--text)">${ap === null ? '-' : ap + '%'}</b></span>
      </div>
    </div>`;
  }).join('') || `<div class="empty">${classesCache.length ? 'No class matches your search.' : 'You are not enrolled in any class yet.'}</div>`;
}

function openClass(classId) {
  const c = classesCache.find((x) => x.id === classId);
  if (!c) return;
  document.getElementById('classesHome').style.display = 'none';
  const box = document.getElementById('classDetail');
  box.style.display = 'block';
  const ap = attPercent(c.attendance);
  box.innerHTML = `
    <button class="back-link" onclick="loadClasses()">← All classes</button>
    <h2 style="margin-bottom:4px">${esc(c.name)}</h2>
    <p class="page-sub" style="margin-top:0">👩‍🏫 ${esc(c.teacherName)} · 👥 ${c.classmates} student(s)</p>
    <div class="summary-row">
      <div class="summary-pill"><b>${c.counts.total}</b>quizzes assigned</div>
      <div class="summary-pill ok"><b>${c.counts.completed}</b>completed</div>
      <div class="summary-pill danger"><b>${c.counts.missed}</b>missed</div>
      <div class="summary-pill"><b>${c.counts.available + c.counts.inProgress}</b>to do now</div>
      <div class="summary-pill"><b>${c.counts.upcoming}</b>upcoming</div>
      <div class="summary-pill ok"><b>${c.averagePercent === null ? '-' : c.averagePercent + '%'}</b>average score</div>
      <div class="summary-pill"><b>${ap === null ? '-' : ap + '%'}</b>attendance (${c.attendance.total} day(s))</div>
    </div>
    <h3>Quizzes</h3>
    <table>
      <thead><tr><th>Quiz</th><th>Status</th><th>Score</th><th>Window</th><th></th></tr></thead>
      <tbody>${c.quizzes.map((q) => `
        <tr>
          <td><b>${esc(q.title)}</b></td>
          <td>${stateBadge(q.state)}</td>
          <td>${q.totalMarks ? `${q.score} / ${q.totalMarks}` : '-'}</td>
          <td>${esc(fmtWindow(q) || 'Always open')}</td>
          <td>${q.state === 'available' || q.state === 'in-progress'
            ? `<button class="btn small" onclick="startQuiz('${q.id}')">${q.state === 'in-progress' ? 'Resume' : 'Start'}</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No quizzes in this class yet.</td></tr>'}
      </tbody>
    </table>
    <h3 style="margin-top:22px">Attendance</h3>
    <div class="summary-row">
      <div class="summary-pill ok"><b>${c.attendance.present}</b>present</div>
      <div class="summary-pill warn"><b>${c.attendance.late}</b>late</div>
      <div class="summary-pill danger"><b>${c.attendance.absent}</b>absent</div>
    </div>`;
  window.scrollTo({ top: 0 });
}

// =================== My Results ===================
let resultsCache = [];
async function loadResults() {
  resultsCache = await api('/student/results');
  fillClassFilter('rClass', resultsCache);
  document.getElementById('rSearch').oninput = renderResults;
  document.getElementById('rClass').onchange = renderResults;
  renderResults();
}
function renderResults() {
  const q = lc(document.getElementById('rSearch').value.trim());
  const cf = document.getElementById('rClass').value;
  const rows = resultsCache
    .filter((r) => !q || lc(r.quizTitle).includes(q) || lc(r.className).includes(q))
    .filter((r) => !cf || r.classId === cf);
  const pcts = rows.map((r) => r.percent).filter((p) => p !== null);
  document.getElementById('rSummary').innerHTML = rows.length ? `
    <div class="summary-pill"><b>${rows.length}</b>quiz(zes)</div>
    <div class="summary-pill ok"><b>${pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) + '%' : '-'}</b>average</div>
    <div class="summary-pill"><b>${pcts.length ? Math.max(...pcts) + '%' : '-'}</b>best</div>` : '';
  document.getElementById('resultRows').innerHTML = rows.map((r) => `
    <tr class="rv-row" data-review="/student/results/${encodeURIComponent(r.id)}/review" tabindex="0" title="See your answers">
      <td><b>${esc(r.quizTitle)}</b> <span class="rv-row-hint">View answers</span></td>
      <td>${esc(r.className || '-')}</td>
      <td>${esc(r.teacherName || '-')}</td>
      <td>${r.score} / ${r.totalMarks}${r.percent !== null ? ` <small style="color:var(--muted)">(${r.percent}%)</small>` : ''}</td>
      <td><span class="badge ${r.status === 'submitted' ? 'ok' : 'warn'}">${esc(r.status)}</span></td>
      <td>${fmtDate(r.submittedAt)}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="color:var(--muted)">${resultsCache.length ? 'No result matches your search.' : 'No completed quizzes yet.'}</td></tr>`;
}

// =================== My Attendance ===================
let attCache = [];
async function loadAttendance() {
  attCache = await api('/student/attendance');
  fillClassFilter('aClass', attCache);
  ['aClass', 'aFrom', 'aTo', 'aStatus', 'aSearch'].forEach((id) => {
    const el = document.getElementById(id);
    el.oninput = renderAttendance; el.onchange = renderAttendance;
  });
  renderAttendance();
}
function renderAttendance() {
  const cf = document.getElementById('aClass').value;
  const from = document.getElementById('aFrom').value;
  const to = document.getElementById('aTo').value;
  const sf = document.getElementById('aStatus').value;
  const q = lc(document.getElementById('aSearch').value.trim());
  const rows = attCache
    .filter((r) => (!cf || r.classId === cf) && (!from || r.date >= from) && (!to || r.date <= to) && (!sf || r.status === sf))
    .filter((r) => !q || lc(r.className).includes(q) || lc(r.teacherName).includes(q));
  const n = (s) => rows.filter((r) => r.status === s).length;
  document.getElementById('aSummary').innerHTML = rows.length ? `
    <div class="summary-pill ok"><b>${n('present')}</b>present</div>
    <div class="summary-pill warn"><b>${n('late')}</b>late</div>
    <div class="summary-pill danger"><b>${n('absent')}</b>absent</div>
    <div class="summary-pill"><b>${Math.round(((n('present') + n('late')) / rows.length) * 100)}%</b>attendance</div>` : '';
  const badge = (s) => `<span class="badge ${s === 'present' ? 'ok' : s === 'late' ? 'warn' : 'danger'}">${esc(s)}</span>`;
  document.getElementById('attRows').innerHTML = rows.map((r) => `
    <tr><td>${esc(r.date)}</td><td><b>${esc(r.className)}</b></td><td>${esc(r.teacherName)}</td><td>${badge(r.status)}</td></tr>
  `).join('') || `<tr><td colspan="4" style="color:var(--muted)">${attCache.length ? 'No records match your filters.' : 'No attendance recorded yet.'}</td></tr>`;
}

loadQuizzes();
