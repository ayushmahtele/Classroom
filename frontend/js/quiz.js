const me = Session.requireRole('student');
const params = new URLSearchParams(window.location.search);
const quizId = params.get('quizId');
if (!quizId) window.location.href = 'student.html';

let quiz = null;
let attempt = null;
let currentIndex = 0;
let timerInterval = null;
let deadline = null;

// ---- Pre-check: warm up camera + models before the quiz officially starts
(async function preCheck() {
  const errorEl = document.getElementById('preCheckError');
  const startBtn = document.getElementById('startBtn');
  startBtn.disabled = true;
  startBtn.textContent = 'Preparing…';
  try {
    await Proctor.requestCamera(document.getElementById('preCheckVideo'));
    await Proctor.loadModels((msg) => (startBtn.textContent = msg));
    startBtn.disabled = false;
    startBtn.textContent = 'Enable camera & start quiz';
  } catch (e) {
    errorEl.textContent = 'Camera access is required to take a proctored quiz: ' + e.message;
  }
})();

async function beginQuiz() {
  const errorEl = document.getElementById('preCheckError');
  try {
    await document.documentElement.requestFullscreen?.();
  } catch (e) { /* some browsers/devices restrict this - continue anyway */ }

  try {
    attempt = await api(`/student/quizzes/${quizId}/start`, { method: 'POST' });
    quiz = await api(`/student/quizzes/${quizId}`);
  } catch (e) {
    errorEl.textContent = e.message;
    return;
  }

  document.getElementById('preCheckScreen').style.display = 'none';
  document.getElementById('quizShell').style.display = 'flex';
  document.getElementById('quizTitle').textContent = quiz.title;

  const proctorVideo = document.getElementById('proctorVideo');
  proctorVideo.srcObject = Proctor.getStream();

  Proctor.init({
    video: proctorVideo,
    attemptId: attempt.id,
    quizId: quiz.id,
    lookAwayStrictness: quiz.lookAwayStrictness || 'medium',
    onEvent: logProctorEvent,
    flagAttempt: (field) => api(`/student/attempts/${attempt.id}/flag`, { method: 'POST', body: { field } }).catch(() => {}),
    onFullscreenExit: () => {
      logProctorEvent({ type: 'SYSTEM', meta: {}, timestamp: new Date().toISOString(), note: 'Please return to fullscreen.' });
    },
    onCameraLost: () => {
      document.getElementById('camStatus').textContent = 'Camera disconnected!';
      document.getElementById('camStatus').className = 'cam-status bad';
    }
  });
  Proctor.start();

  renderQuestionNav();
  renderQuestion(0);
  startTimer();
}

function logProctorEvent(ev) {
  const log = document.getElementById('proctorLog');
  const div = document.createElement('div');
  const severe = ['NO_FACE', 'MULTIPLE_FACES', 'PHONE_DETECTED'].includes(ev.type);
  div.className = 'entry' + (severe ? ' high' : '');
  const label = ev.note || ev.type.replace(/_/g, ' ');
  div.textContent = `${new Date(ev.timestamp).toLocaleTimeString()} — ${label}`;
  log.prepend(div);
  while (log.children.length > 100) log.lastChild.remove(); // keep the log light
  if (ev.type !== 'SYSTEM') showWarningToast(label);
}

// Pop-up warning shown every time an event is raised (i.e. repeats every 5 seconds
// while the violation continues); it disappears ~2s after the last event.
let toastTimer = null;
function showWarningToast(label) {
  let t = document.getElementById('warnToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'warnToast';
    t.className = 'warn-toast';
    document.body.appendChild(t);
  }
  t.textContent = '⚠ ' + label;
  t.classList.remove('pop');
  void t.offsetWidth; // restart the animation so each repeat visibly "pops"
  t.classList.add('show', 'pop');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

function startTimer() {
  const started = new Date(attempt.startedAt).getTime();
  deadline = started + quiz.durationMinutes * 60000;
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}
function updateTimer() {
  const remainingMs = deadline - Date.now();
  const el = document.getElementById('timerDisplay');
  if (remainingMs <= 0) {
    el.textContent = '00:00';
    clearInterval(timerInterval);
    submitQuiz(true);
    return;
  }
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  el.className = 'timer' + (remainingMs < 60000 ? ' low' : '');
}

function renderQuestionNav() {
  const nav = document.getElementById('questionNav');
  nav.innerHTML = quiz.questions.map((q, i) => `<button id="navq-${i}" onclick="renderQuestion(${i})">${i + 1}</button>`).join('');
}

function isAnswered(q) {
  const v = attempt.answers[q.id];
  if (v === undefined || v === null) return false;
  return q.type === 'direct' ? String(v).trim() !== '' : true;
}

function refreshNavState() {
  document.querySelectorAll('.question-nav button').forEach((b, idx) => {
    b.classList.toggle('current', idx === currentIndex);
    b.classList.toggle('answered', isAnswered(quiz.questions[idx]));
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderQuestion(i) {
  currentIndex = i;
  const q = quiz.questions[i];
  const selected = attempt.answers[q.id];
  const head = `
      <p style="color:var(--muted);font-size:13px">Question ${i + 1} of ${quiz.questions.length} &middot; ${q.marks} mark(s)</p>
      <h3>${q.text}</h3>`;
  const body = q.type === 'direct'
    ? `<textarea id="directAnswer" rows="3" placeholder="Type your answer here" autocomplete="off" spellcheck="false"
         style="width:100%;margin-top:10px" oninput="onDirectInput('${q.id}', this.value)">${escapeHtml(selected ?? '')}</textarea>`
    : (q.options || []).map((opt, oi) => `
        <div class="option-choice ${selected === oi ? 'selected' : ''}" onclick="selectAnswer('${q.id}', ${oi})">
          <input type="radio" name="opt" ${selected === oi ? 'checked' : ''} readonly />
          <span>${opt}</span>
        </div>
      `).join('');
  document.getElementById('questionArea').innerHTML = `<div class="question-card">${head}${body}</div>`;
  refreshNavState();
}

async function selectAnswer(questionId, optionIndex) {
  attempt.answers[questionId] = optionIndex;
  renderQuestion(currentIndex);
  try {
    await api(`/student/attempts/${attempt.id}/answer`, { method: 'PATCH', body: { questionId, optionIndex } });
  } catch (e) { /* will retry on next click; not fatal */ }
}

// Direct-answer questions: keep the text box untouched while typing (no re-render),
// save to the server shortly after the student stops typing.
const directSaveTimers = {};
function onDirectInput(questionId, value) {
  attempt.answers[questionId] = value;
  refreshNavState();
  clearTimeout(directSaveTimers[questionId]);
  directSaveTimers[questionId] = setTimeout(() => saveDirectAnswer(questionId), 500);
}
async function saveDirectAnswer(questionId) {
  try {
    await api(`/student/attempts/${attempt.id}/answer`, { method: 'PATCH', body: { questionId, answer: attempt.answers[questionId] ?? '' } });
  } catch (e) { /* retried on the next keystroke / question change */ }
}
// flush any pending typed answers immediately (used before moving on / submitting)
async function flushDirectAnswers() {
  const pending = Object.keys(directSaveTimers);
  pending.forEach((qid) => clearTimeout(directSaveTimers[qid]));
  await Promise.all(pending.map((qid) => saveDirectAnswer(qid)));
}

function prevQuestion() { if (currentIndex > 0) renderQuestion(currentIndex - 1); }
function nextQuestion() { if (currentIndex < quiz.questions.length - 1) renderQuestion(currentIndex + 1); }

function confirmSubmit() {
  const unanswered = quiz.questions.filter((q) => !isAnswered(q)).length;
  const msg = unanswered
    ? `You have ${unanswered} unanswered question(s). Submit anyway?`
    : 'Submit your quiz now? This cannot be undone.';
  if (confirm(msg)) submitQuiz(false);
}

async function submitQuiz(auto) {
  clearInterval(timerInterval);
  Proctor.stop();
  try { await flushDirectAnswers(); } catch (e) { /* best effort */ }
  try {
    await api(`/student/attempts/${attempt.id}/submit`, { method: 'POST', body: { auto } });
  } catch (e) { /* ignore - may already be submitted by a race with the timer */ }
  if (document.fullscreenElement) document.exitFullscreen?.();
  alert(auto ? 'Time is up! Your quiz has been auto-submitted.' : 'Quiz submitted successfully.');
  window.location.href = 'student.html';
}

window.addEventListener('beforeunload', (e) => {
  if (attempt && attempt.status === 'in-progress') {
    e.preventDefault();
    e.returnValue = '';
  }
});
