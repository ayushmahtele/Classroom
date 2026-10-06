// Answer review: click a row in Results to see every question — what was
// answered, whether it was right or wrong, and the correct answer.
// Students: My Results -> click a quiz.  Teachers: Results -> click a student.
// Rows opt in with data-review="<api path>". Needs js/api.js.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMarks = (n) => (Math.round(n * 100) / 100).toString();
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  let backdrop = null;
  let lastFocus = null;

  function close() {
    if (!backdrop) return;
    backdrop.remove();
    backdrop = null;
    document.body.classList.remove('rv-open');
    if (lastFocus) lastFocus.focus();
  }

  function shell(title) {
    close();
    lastFocus = document.activeElement;
    backdrop = document.createElement('div');
    backdrop.className = 'rv-backdrop';
    backdrop.innerHTML = `
      <div class="rv-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="rv-head">
          <div class="rv-head-text"><h3 class="rv-title">${esc(title)}</h3><div class="rv-sub"></div></div>
          <button type="button" class="rv-close" aria-label="Close">✕</button>
        </div>
        <div class="rv-body"><p class="rv-muted">Loading answers…</p></div>
      </div>`;
    document.body.appendChild(backdrop);
    document.body.classList.add('rv-open');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('.rv-close').addEventListener('click', close);
    backdrop.querySelector('.rv-close').focus();
    return backdrop;
  }

  const RESULT_LABEL = { correct: 'Correct', wrong: 'Wrong', unanswered: 'Not answered' };

  function questionHtml(q, reveal) {
    const earned = q.result === 'unanswered' ? '0' : (q.earned > 0 ? '+' : '') + fmtMarks(q.earned);
    let body = '';
    if (q.type === 'mcq') {
      body = `<ul class="rv-options">${q.options.map((opt, i) => {
        const mine = q.yourIndex === i;
        const right = reveal && q.correctIndex === i;
        const cls = mine && q.result === 'correct' ? 'is-right' : mine ? 'is-wrong' : right ? 'is-answer' : '';
        const tags = [
          mine ? `<span class="rv-tag ${q.result === 'correct' ? 'ok' : 'bad'}">${q.result === 'correct' ? '✓ ' : '✗ '}Chosen answer</span>` : '',
          right && !mine ? '<span class="rv-tag ok">✓ Correct answer</span>' : ''
        ].join('');
        return `<li class="rv-opt ${cls}"><span class="rv-letter">${LETTERS[i] || i + 1}</span><span class="rv-opt-text">${esc(opt)}</span>${tags}</li>`;
      }).join('')}</ul>`;
    } else {
      const given = q.yourAnswer === null
        ? '<span class="rv-muted">No answer</span>'
        : `<span class="rv-typed ${q.result === 'correct' ? 'ok' : 'bad'}">${esc(q.yourAnswer)}</span>`;
      body = `<div class="rv-direct">
          <div><span class="rv-k">Answer given</span>${given}</div>
          ${reveal ? `<div><span class="rv-k">Correct answer</span><span class="rv-typed ok">${q.correctAnswers.map(esc).join('</span> <span class="rv-or">or</span> <span class="rv-typed ok">')}</span></div>` : ''}
        </div>`;
    }
    return `
      <article class="rv-q ${q.result}" data-result="${q.result}">
        <div class="rv-q-head">
          <span class="rv-qn">Q${q.n}</span>
          <span class="rv-badge ${q.result}">${RESULT_LABEL[q.result]}</span>
          <span class="rv-marks">${earned} / ${fmtMarks(q.marks)} mark${q.marks === 1 ? '' : 's'}</span>
        </div>
        <p class="rv-q-text">${esc(q.text)}</p>
        ${body}
      </article>`;
  }

  async function openReview(path) {
    const el = shell('Answers');
    const body = el.querySelector('.rv-body');
    let r;
    try { r = await api(path); } catch (err) { body.innerHTML = `<p class="error-msg">${esc(err.message)}</p>`; return; }

    el.querySelector('.rv-title').textContent = r.quizTitle;
    el.querySelector('.rv-modal').setAttribute('aria-label', `Answers — ${r.quizTitle}`);
    el.querySelector('.rv-sub').innerHTML = [
      r.studentName ? `${esc(r.studentName)}${r.studentRoll ? ` · <b>${esc(r.studentRoll)}</b>` : ''}` : '',
      `Score <b>${r.score ?? '-'} / ${r.totalMarks}</b>${r.percent !== null ? ` (${r.percent}%)` : ''}`,
      r.status && r.status !== 'submitted' ? `<span class="badge ${r.status === 'auto-submitted' ? 'warn' : 'muted'}">${esc(r.status)}</span>` : ''
    ].filter(Boolean).map((x) => `<span>${x}</span>`).join('<span class="rv-dot"></span>');

    const c = r.counts;
    const notes = [];
    if (!r.revealCorrect) notes.push(`Correct answers will be shown after the quiz closes${r.revealAt ? ` on <b>${esc(new Date(r.revealAt).toLocaleString())}</b>` : ''}. You can already see which answers were right or wrong.`);
    if (r.negativeMarking) notes.push('This quiz has negative marking: a wrong multiple-choice answer takes away ¼ of its marks.');

    body.innerHTML = `
      <div class="rv-filters" role="group" aria-label="Show questions">
        <button type="button" class="rv-chip active" data-f="all">All <b>${r.questions.length}</b></button>
        <button type="button" class="rv-chip ok" data-f="correct">Correct <b>${c.correct}</b></button>
        <button type="button" class="rv-chip bad" data-f="wrong">Wrong <b>${c.wrong}</b></button>
        <button type="button" class="rv-chip muted" data-f="unanswered">Not answered <b>${c.unanswered}</b></button>
      </div>
      ${notes.map((n) => `<p class="rv-note">${n}</p>`).join('')}
      <div class="rv-list">${r.questions.map((q) => questionHtml(q, r.revealCorrect)).join('')}</div>
      <p class="rv-empty rv-muted" hidden>No questions in this group.</p>`;

    body.querySelectorAll('.rv-chip').forEach((chip) => chip.addEventListener('click', () => {
      body.querySelectorAll('.rv-chip').forEach((x) => x.classList.toggle('active', x === chip));
      const f = chip.dataset.f;
      let shown = 0;
      body.querySelectorAll('.rv-q').forEach((q) => { const on = f === 'all' || q.dataset.result === f; q.hidden = !on; if (on) shown++; });
      body.querySelector('.rv-empty').hidden = shown > 0;
    }));
  }

  // Rows marked with data-review open the review (click, Enter or Space)
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-review]');
    if (row && !e.target.closest('a, button, input, select')) openReview(row.dataset.review);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop) { close(); return; }
    const row = e.target.closest && e.target.closest('[data-review]');
    if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); openReview(row.dataset.review); }
  });

  window.openReview = openReview;
})();
