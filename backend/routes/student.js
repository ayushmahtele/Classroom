const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { id } = require('../utils/helpers');
const { buildReview } = require('../utils/review');

// Case/spacing-insensitive match against any accepted answer ("a|b|c"); numbers compare numerically (2 == 2.0)
function normAnswer(v) { return String(v).trim().toLowerCase().replace(/\s+/g, ' '); }
function directAnswerMatches(given, accepted) {
  const g = normAnswer(given);
  return String(accepted).split('|').some((a) => {
    const n = normAnswer(a);
    if (!n) return false;
    if (n === g) return true;
    return n !== '' && g !== '' && !isNaN(Number(n)) && !isNaN(Number(g)) && Number(n) === Number(g);
  });
}

const router = express.Router();
router.use(authRequired, requireRole('student'));

function myClasses(studentId) {
  return db.classes.find((c) => c.studentIds.includes(studentId));
}

// Classes the student is CURRENTLY in: if a teacher (or an admin) removed the
// student from that teacher, the teacher's classes no longer show up here.
// (Used for the student's lists/dashboards only.)
function activeClasses(studentId) {
  const me = db.users.findById(studentId);
  const linked = (c) => !Array.isArray(me?.teacherIds) || me.teacherIds.includes(c.teacherId);
  return myClasses(studentId).filter(linked);
}

const teacherName = (tid) => db.users.findById(tid)?.name || '';
const isDone = (a) => a && a.status !== 'in-progress';

/** completed | in-progress | available | upcoming | missed */
function quizState(q, attempt, now = new Date()) {
  if (isDone(attempt)) return 'completed';
  const notYet = q.startTime && new Date(q.startTime) > now;
  const closed = q.endTime && now > new Date(q.endTime);
  if (closed) return 'missed';
  if (attempt) return 'in-progress';
  return notYet ? 'upcoming' : 'available';
}

function quizSummary(q, studentId, cls, now) {
  const attempt = db.attempts.findOne((a) => a.quizId === q.id && a.studentId === studentId);
  return {
    id: q.id,
    title: q.title,
    classId: q.classId,
    className: cls?.name || '',
    teacherName: teacherName(q.teacherId),
    durationMinutes: q.durationMinutes,
    questionCount: q.questions.length,
    startTime: q.startTime,
    endTime: q.endTime,
    state: quizState(q, attempt, now),
    score: isDone(attempt) ? attempt.score : null,
    totalMarks: isDone(attempt) ? attempt.totalMarks : null,
    submittedAt: isDone(attempt) ? attempt.submittedAt : null
  };
}

// ---- Profile --------------------------------------------------------------
router.get('/profile', (req, res) => {
  const me = db.users.findById(req.user.id);
  const college = me.collegeId ? db.colleges.findById(me.collegeId) : null;
  const classes = activeClasses(me.id).map((c) => ({
    id: c.id,
    name: c.name,
    teacherName: db.users.findById(c.teacherId)?.name || ''
  }));
  res.json({
    id: me.id,
    studentId: me.loginId,
    name: me.name,
    email: me.email,
    rollNumber: me.rollNumber || '',
    department: me.department || '',
    collegeName: college?.name || '',
    collegeShort: college?.shortName || '',
    totalClasses: classes.length,
    classes
  });
});

// ---- Assigned quizzes ---------------------------------------------------
router.get('/quizzes', (req, res) => {
  const classes = Object.fromEntries(activeClasses(req.user.id).map((c) => [c.id, c]));
  const now = new Date();
  const quizzes = db.quizzes
    .find((q) => classes[q.classId] && q.published)
    .map((q) => {
      const attempt = db.attempts.findOne((a) => a.quizId === q.id && a.studentId === req.user.id);
      const windowOpen =
        (!q.startTime || new Date(q.startTime) <= now) && (!q.endTime || now <= new Date(q.endTime));
      return {
        ...quizSummary(q, req.user.id, classes[q.classId], now),
        description: q.description,
        windowOpen,
        attemptStatus: attempt ? attempt.status : 'not-started'
      };
    });
  res.json(quizzes);
});

// ---- My classes: each class with its teacher, quiz counts and attendance -------
// Deleted quizzes are simply gone, so the counts go down automatically.
router.get('/classes', (req, res) => {
  const now = new Date();
  const out = activeClasses(req.user.id).map((c) => {
    const quizzes = db.quizzes
      .find((q) => q.classId === c.id && q.published)
      .map((q) => quizSummary(q, req.user.id, c, now))
      .sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')));
    const count = (s) => quizzes.filter((q) => q.state === s).length;
    const att = db.attendance.find((a) => a.classId === c.id && a.studentId === req.user.id);
    const done = quizzes.filter((q) => q.state === 'completed' && q.totalMarks);
    return {
      id: c.id,
      name: c.name,
      teacherName: teacherName(c.teacherId),
      classmates: c.studentIds.length,
      quizzes,
      counts: {
        total: quizzes.length, completed: count('completed'), missed: count('missed'),
        available: count('available'), inProgress: count('in-progress'), upcoming: count('upcoming')
      },
      averagePercent: done.length
        ? Math.round(done.reduce((s, q) => s + (q.score / q.totalMarks) * 100, 0) / done.length)
        : null,
      attendance: {
        total: att.length,
        present: att.filter((a) => a.status === 'present').length,
        late: att.filter((a) => a.status === 'late').length,
        absent: att.filter((a) => a.status === 'absent').length
      }
    };
  });
  res.json(out);
});

// Quiz questions WITHOUT correct answers - used to render the quiz UI
router.get('/quizzes/:id', (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  const classIds = myClasses(req.user.id).map((c) => c.id);
  if (!quiz || !quiz.published || !classIds.includes(quiz.classId)) {
    return res.status(404).json({ error: 'Quiz not available' });
  }
  // never send correct answers; direct-answer questions have no options at all
  const safeQuestions = quiz.questions.map((q) => (q.type === 'direct'
    ? { id: q.id, type: 'direct', text: q.text, marks: q.marks }
    : { id: q.id, type: 'mcq', text: q.text, options: q.options, marks: q.marks }));
  res.json({
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    durationMinutes: quiz.durationMinutes,
    lookAwayStrictness: quiz.lookAwayStrictness || 'medium',
    questions: safeQuestions
  });
});

// ---- Attempts ------------------------------------------------------------
router.post('/quizzes/:id/start', async (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  const classIds = myClasses(req.user.id).map((c) => c.id);
  if (!quiz || !quiz.published || !classIds.includes(quiz.classId)) {
    return res.status(404).json({ error: 'Quiz not available' });
  }
  let attempt = db.attempts.findOne((a) => a.quizId === quiz.id && a.studentId === req.user.id);
  if (attempt) {
    if (attempt.status !== 'in-progress') {
      return res.status(409).json({ error: 'You have already attempted this quiz' });
    }
    return res.json(attempt);
  }
  attempt = {
    id: id(),
    quizId: quiz.id,
    studentId: req.user.id,
    startedAt: new Date().toISOString(),
    submittedAt: null,
    answers: {},
    score: null,
    totalMarks: quiz.questions.reduce((s, q) => s + (q.marks || 1), 0),
    status: 'in-progress',
    tabSwitches: 0,
    fullscreenExits: 0,
    alertCount: 0
  };
  await db.attempts.insert(attempt);
  res.status(201).json(attempt);
});

router.patch('/attempts/:id/answer', async (req, res) => {
  const attempt = db.attempts.findById(req.params.id);
  if (!attempt || attempt.studentId !== req.user.id) return res.status(404).json({ error: 'Attempt not found' });
  if (attempt.status !== 'in-progress') return res.status(409).json({ error: 'Attempt already submitted' });
  const { questionId, optionIndex, answer } = req.body || {};
  const quiz = db.quizzes.findById(attempt.quizId);
  const question = quiz?.questions.find((q) => q.id === questionId);
  if (!question) return res.status(400).json({ error: 'Unknown question' });
  // direct-answer questions store the typed text; MCQ questions store the option index
  const value = question.type === 'direct' ? String(answer ?? '').slice(0, 1000) : optionIndex;
  const answers = { ...attempt.answers, [questionId]: value };
  const updated = await db.attempts.update(attempt.id, { answers });
  res.json(updated);
});

// increment a lightweight behavioural counter (tab switch / fullscreen exit)
router.post('/attempts/:id/flag', async (req, res) => {
  const attempt = db.attempts.findById(req.params.id);
  if (!attempt || attempt.studentId !== req.user.id) return res.status(404).json({ error: 'Attempt not found' });
  const { field } = req.body || {}; // 'tabSwitches' | 'fullscreenExits'
  if (!['tabSwitches', 'fullscreenExits'].includes(field)) return res.status(400).json({ error: 'bad field' });
  const updated = await db.attempts.update(attempt.id, { [field]: (attempt[field] || 0) + 1 });
  res.json(updated);
});

router.post('/attempts/:id/submit', async (req, res) => {
  const attempt = db.attempts.findById(req.params.id);
  if (!attempt || attempt.studentId !== req.user.id) return res.status(404).json({ error: 'Attempt not found' });
  if (attempt.status !== 'in-progress') return res.status(409).json({ error: 'Already submitted' });

  const quiz = db.quizzes.findById(attempt.quizId);
  let score = 0;
  for (const q of quiz.questions) {
    const given = attempt.answers[q.id];
    if (given === undefined || given === null) continue;
    if (q.type === 'direct') {
      // typed answers: blank = unanswered; a wrong one is never penalised
      if (String(given).trim() === '') continue;
      if (directAnswerMatches(given, q.correctAnswer)) score += q.marks || 1;
      continue;
    }
    if (given === q.correctIndex) score += q.marks || 1;
    else if (quiz.negativeMarking) score -= (q.marks || 1) * 0.25;
  }
  const status = req.body?.auto ? 'auto-submitted' : 'submitted';
  const updated = await db.attempts.update(attempt.id, {
    submittedAt: new Date().toISOString(),
    score: Math.max(0, Math.round(score * 100) / 100),
    status
  });
  res.json(updated);
});

// ---- Results & attendance ------------------------------------------------
// Results of quizzes that still exist (a deleted quiz's result disappears with it),
// with class and teacher name, newest first.
router.get('/results', (req, res) => {
  const attempts = db.attempts.find((a) => a.studentId === req.user.id && a.submittedAt);
  const rows = [];
  for (const a of attempts) {
    const quiz = db.quizzes.findById(a.quizId);
    if (!quiz) continue;
    const cls = db.classes.findById(quiz.classId);
    const { answers, ...rest } = a;
    rows.push({
      ...rest,
      quizTitle: quiz.title,
      classId: quiz.classId,
      className: cls?.name || '',
      teacherName: teacherName(quiz.teacherId),
      percent: a.totalMarks ? Math.round((a.score / a.totalMarks) * 100) : null
    });
  }
  rows.sort((x, y) => String(y.submittedAt).localeCompare(String(x.submittedAt)));
  res.json(rows);
});

// Question-by-question review of one of my submitted attempts.
// Right / wrong is shown straight away. The correct answers are shown once the
// quiz has closed (its end time has passed), so they can't be passed on to
// classmates who are still taking it. A quiz without an end time shows them
// straight away.
router.get('/results/:id/review', (req, res) => {
  const attempt = db.attempts.findById(req.params.id);
  if (!attempt || attempt.studentId !== req.user.id || !attempt.submittedAt) {
    return res.status(404).json({ error: 'Result not found' });
  }
  const quiz = db.quizzes.findById(attempt.quizId);
  if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists' });
  const closesAt = quiz.endTime ? new Date(quiz.endTime) : null;
  const revealCorrect = !closesAt || closesAt <= new Date();
  const review = buildReview(quiz, attempt, { revealCorrect });
  review.revealAt = revealCorrect ? null : quiz.endTime;
  res.json(review);
});

// Attendance with class and teacher name, newest first.
router.get('/attendance', (req, res) => {
  const rows = [];
  for (const a of db.attendance.find((x) => x.studentId === req.user.id)) {
    const cls = db.classes.findById(a.classId);
    if (!cls) continue;
    rows.push({ ...a, className: cls.name, teacherName: teacherName(cls.teacherId) });
  }
  rows.sort((x, y) => y.date.localeCompare(x.date));
  res.json(rows);
});

module.exports = router;
