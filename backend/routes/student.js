const express = require('express');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { id } = require('../utils/helpers');

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

// ---- Profile --------------------------------------------------------------
router.get('/profile', (req, res) => {
  const me = db.users.findById(req.user.id);
  const classes = myClasses(me.id).map((c) => ({
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
    totalClasses: classes.length,
    classes
  });
});

// ---- Assigned quizzes ---------------------------------------------------
router.get('/quizzes', (req, res) => {
  const classIds = myClasses(req.user.id).map((c) => c.id);
  const now = new Date();
  const quizzes = db.quizzes
    .find((q) => classIds.includes(q.classId) && q.published)
    .map((q) => {
      const attempt = db.attempts.findOne((a) => a.quizId === q.id && a.studentId === req.user.id);
      const windowOpen =
        (!q.startTime || new Date(q.startTime) <= now) && (!q.endTime || now <= new Date(q.endTime));
      return {
        id: q.id,
        title: q.title,
        description: q.description,
        durationMinutes: q.durationMinutes,
        startTime: q.startTime,
        endTime: q.endTime,
        questionCount: q.questions.length,
        windowOpen,
        attemptStatus: attempt ? attempt.status : 'not-started'
      };
    });
  res.json(quizzes);
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
router.get('/results', (req, res) => {
  const attempts = db.attempts.find((a) => a.studentId === req.user.id && a.submittedAt);
  const withTitles = attempts.map((a) => {
    const quiz = db.quizzes.findById(a.quizId);
    return { ...a, quizTitle: quiz?.title };
  });
  res.json(withTitles);
});

router.get('/attendance', (req, res) => {
  res.json(db.attendance.find((a) => a.studentId === req.user.id));
});

module.exports = router;
