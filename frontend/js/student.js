const me = Session.requireRole('student');
document.getElementById('whoBox').textContent = `${me.name} (${me.loginId})`;

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.main > section').forEach((s) => (s.style.display = 'none'));
    document.getElementById(`view-${btn.dataset.view}`).style.display = 'block';
    if (btn.dataset.view === 'quizzes') loadQuizzes();
    if (btn.dataset.view === 'results') loadResults();
    if (btn.dataset.view === 'attendance') loadAttendance();
    if (btn.dataset.view === 'profile') loadProfile('student');
  });
});

async function loadQuizzes() {
  const quizzes = await api('/student/quizzes');
  document.getElementById('quizList').innerHTML = quizzes.map((q) => `
    <div class="panel">
      <h3>${q.title}</h3>
      <p style="color:var(--muted);font-size:13px">${q.description || ''}</p>
      <p style="font-size:13px">⏱ ${q.durationMinutes} min &nbsp;|&nbsp; ${q.questionCount} question(s)</p>
      ${statusBadge(q)}
      ${actionButton(q)}
    </div>
  `).join('') || '<p style="color:var(--muted)">No quizzes assigned yet.</p>';
}

function statusBadge(q) {
  if (q.attemptStatus === 'submitted' || q.attemptStatus === 'auto-submitted') {
    return `<span class="badge ok">Completed</span>`;
  }
  if (!q.windowOpen) return `<span class="badge muted">Not open right now</span>`;
  if (q.attemptStatus === 'in-progress') return `<span class="badge warn">In progress</span>`;
  return `<span class="badge muted">Not started</span>`;
}
function actionButton(q) {
  if (q.attemptStatus === 'submitted' || q.attemptStatus === 'auto-submitted') return '';
  if (!q.windowOpen) return '';
  return `<button class="btn full" onclick="startQuiz('${q.id}')">${q.attemptStatus === 'in-progress' ? 'Resume Quiz' : 'Start Quiz'}</button>`;
}

function startQuiz(quizId) {
  window.location.href = `quiz.html?quizId=${quizId}`;
}

async function loadResults() {
  const rows = await api('/student/results');
  document.getElementById('resultRows').innerHTML = rows.map((r) => `
    <tr><td>${r.quizTitle}</td><td>${r.score} / ${r.totalMarks}</td><td>${r.status}</td><td>${fmtDate(r.submittedAt)}</td></tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--muted)">No completed quizzes yet.</td></tr>';
}

async function loadAttendance() {
  const rows = await api('/student/attendance');
  document.getElementById('attRows').innerHTML = rows.map((r) => `
    <tr><td>${r.date}</td><td>${r.status}</td></tr>
  `).join('') || '<tr><td colspan="2" style="color:var(--muted)">No attendance recorded yet.</td></tr>';
}

loadQuizzes();
