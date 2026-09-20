const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const recycle = require('../utils/recycle');
const { id, tempPassword, readableId, DEPARTMENTS, teacherDepartments, nextRollNumber, studentVisibleTo } = require('../utils/helpers');

const router = express.Router();
router.use(authRequired, requireRole('teacher'));

// ---- Profile ------------------------------------------------------------
router.get('/me', (req, res) => {
  const me = db.users.findById(req.user.id);
  const classes = db.classes
    .find((c) => c.teacherId === me.id)
    .map((c) => ({ id: c.id, name: c.name, studentCount: c.studentIds.length }));
  res.json({
    id: me.id,
    teacherId: me.loginId,
    name: me.name,
    email: me.email,
    departments: teacherDepartments(me),
    totalClasses: classes.length,
    classes
  });
});

// ---- Students ---------------------------------------------------------
// Adds a student to some of this teacher's classes (never removes anyone).
async function enrollStudentInClasses(teacherId, studentId, classIds) {
  let added = 0;
  for (const classId of classIds) {
    const cls = db.classes.findById(classId);
    if (!cls || cls.teacherId !== teacherId) continue;
    if (!cls.studentIds.includes(studentId)) {
      await db.classes.update(cls.id, { studentIds: [...cls.studentIds, studentId] });
      added++;
    }
  }
  return added;
}

// Works out which of this teacher's classes a request refers to.
//   mode 'selected' -> the classIds given (must all be this teacher's)
//   mode 'all'      -> every class of this teacher
function pickClasses(teacherId, mode, classIds) {
  const mine = db.classes.find((c) => c.teacherId === teacherId);
  if (mode === 'all') return { ids: mine.map((c) => c.id) };
  const wanted = new Set(Array.isArray(classIds) ? classIds : []);
  const ids = mine.filter((c) => wanted.has(c.id)).map((c) => c.id);
  if (!ids.length) return { error: 'Select at least one class' };
  return { ids };
}

// Teacher creates a student and chooses who else gets them:
//   assignMode 'me'     -> only this teacher
//   assignMode 'domain' -> all teachers who share this teacher's department(s)
//   assignMode 'all'    -> every teacher, whatever their department
// Optionally also puts the student in this teacher's class(es):
//   classMode 'none' | 'selected' (classIds) | 'all'
router.post('/students', async (req, res) => {
  const { name, email, department, assignMode = 'me', classMode = 'none', classIds } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  if (!['me', 'domain', 'all'].includes(assignMode)) return res.status(400).json({ error: 'Invalid teacher option' });
  if (!['none', 'selected', 'all'].includes(classMode)) return res.status(400).json({ error: 'Invalid class option' });

  const exists = db.users.findOne((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'A user with this email already exists' });

  const self = db.users.findById(req.user.id);
  const myDepts = teacherDepartments(self);
  const domain = String(department || '').trim().toUpperCase();
  if (!DEPARTMENTS.includes(domain) || (myDepts.length && !myDepts.includes(domain))) {
    return res.status(400).json({ error: `Choose the student's domain${myDepts.length ? ` (${myDepts.join(', ')})` : ''}` });
  }

  let teacherIds = [self.id];
  if (assignMode === 'domain') {
    if (!myDepts.length) return res.status(400).json({ error: 'Your account has no department set. Ask the admin to add one.' });
    teacherIds = db.users
      .find((u) => u.role === 'teacher' && (u.id === self.id || teacherDepartments(u).some((d) => myDepts.includes(d))))
      .map((u) => u.id);
  } else if (assignMode === 'all') {
    teacherIds = db.users.find((u) => u.role === 'teacher').map((u) => u.id);
  }

  let classesToJoin = [];
  if (classMode !== 'none') {
    const picked = pickClasses(self.id, classMode, classIds);
    if (picked.error) return res.status(400).json({ error: picked.error });
    classesToJoin = picked.ids;
  }

  const loginId = readableId('STU');
  const plainPassword = tempPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const student = {
    id: id(),
    role: 'student',
    name,
    email,
    department: domain,
    rollNumber: nextRollNumber(db.users.all()), // auto-generated
    loginId,
    passwordHash,
    mustChangePassword: true,
    status: 'active',
    teacherIds,
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(student);
  const enrolled = await enrollStudentInClasses(self.id, student.id, classesToJoin);

  res.status(201).json({
    message: 'Student created. Share these credentials with them securely.',
    credentials: { loginId, temporaryPassword: plainPassword, email },
    student: { id: student.id, name, email, loginId, department: domain, rollNumber: student.rollNumber },
    teachersAssigned: teacherIds.length,
    classesJoined: enrolled
  });
});

// Only the students that belong to this teacher.
router.get('/students', (req, res) => {
  const myClasses = db.classes.find((c) => c.teacherId === req.user.id);
  const list = db.users
    .find((u) => u.role === 'student' && studentVisibleTo(u, req.user.id))
    .map(({ passwordHash, ...s }) => ({
      ...s,
      classIds: myClasses.filter((c) => c.studentIds.includes(s.id)).map((c) => c.id)
    }));
  res.json(list);
});

// Teacher issues a new temporary password for one of their students
router.post('/students/:id/reset-password', async (req, res) => {
  const student = db.users.findById(req.params.id);
  if (!student || student.role !== 'student' || !studentVisibleTo(student, req.user.id)) {
    return res.status(404).json({ error: 'Student not found' });
  }
  const plainPassword = tempPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await db.users.update(student.id, { passwordHash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: plainPassword });
});

// Remove a student from THIS teacher only. The student's account stays (other teachers
// keep them), but this teacher's classes, attendance and quiz results/proctoring data for
// that student are removed. Restorable by the admin from the recycle bin.
router.delete('/students/:id', async (req, res) => {
  const student = db.users.findById(req.params.id);
  if (!student || student.role !== 'student' || !studentVisibleTo(student, req.user.id)) {
    return res.status(404).json({ error: 'Student not found' });
  }
  const teacher = db.users.findById(req.user.id);
  await recycle.unlinkStudent(teacher, student);
  res.json({ ok: true });
});

// Add an existing student to one, several or all of this teacher's classes.
router.post('/students/:id/classes', async (req, res) => {
  const student = db.users.findById(req.params.id);
  if (!student || student.role !== 'student' || !studentVisibleTo(student, req.user.id)) {
    return res.status(404).json({ error: 'Student not found' });
  }
  const { mode = 'selected', classIds } = req.body || {};
  if (!['selected', 'all'].includes(mode)) return res.status(400).json({ error: 'Invalid class option' });
  const picked = pickClasses(req.user.id, mode, classIds);
  if (picked.error) return res.status(400).json({ error: picked.error });
  const added = await enrollStudentInClasses(req.user.id, student.id, picked.ids);
  res.json({ ok: true, added });
});

// ---- Classes ------------------------------------------------------------
router.post('/classes', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const cls = { id: id(), name, teacherId: req.user.id, studentIds: [], createdAt: new Date().toISOString() };
  await db.classes.insert(cls);
  res.status(201).json(cls);
});

router.get('/classes', (req, res) => {
  res.json(db.classes.find((c) => c.teacherId === req.user.id));
});

// Deletes the class with its attendance, quizzes, results and proctoring data.
// A copy goes to the recycle bin so the admin can restore it if needed.
router.delete('/classes/:id', async (req, res) => {
  const cls = db.classes.findById(req.params.id);
  if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });
  await recycle.trashClass(cls);
  res.json({ ok: true });
});

router.post('/classes/:id/enroll', async (req, res) => {
  const cls = db.classes.findById(req.params.id);
  if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });
  const { studentId } = req.body || {};
  const student = db.users.findById(studentId);
  if (!student || student.role !== 'student' || !studentVisibleTo(student, req.user.id)) return res.status(404).json({ error: 'Student not found' });
  if (!cls.studentIds.includes(studentId)) cls.studentIds.push(studentId);
  await db.classes.update(cls.id, { studentIds: cls.studentIds });
  res.json(cls);
});

router.post('/classes/:id/unenroll', async (req, res) => {
  const cls = db.classes.findById(req.params.id);
  if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });
  const { studentId } = req.body || {};
  const studentIds = cls.studentIds.filter((s) => s !== studentId);
  await db.classes.update(cls.id, { studentIds });
  res.json({ ok: true });
});

// ---- Quizzes -------------------------------------------------------------
// A question is either:
//   type 'mcq'    -> options[] + correctIndex
//   type 'direct' -> no options; the student types the answer. `correctAnswer`
//                    holds the accepted answer(s); separate alternatives with "|".
// Questions saved before question types existed have no `type` and are MCQ.
function cleanQuestions(rawQuestions, keepIds = new Set()) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { error: 'At least one question is required' };
  }
  const out = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i] || {};
    const n = i + 1;
    const text = String(q.text || '').trim();
    if (!text) return { error: `Question ${n}: question text is required` };
    const marks = Number(q.marks) > 0 ? Number(q.marks) : 1;
    const qid = typeof q.id === 'string' && keepIds.has(q.id) ? q.id : id(); // keep ids of existing questions so old answers still map

    if (q.type === 'direct') {
      const correctAnswer = String(q.correctAnswer || '').trim();
      if (!correctAnswer) return { error: `Question ${n}: the correct answer is required` };
      out.push({ id: qid, type: 'direct', text, correctAnswer, marks });
    } else {
      const options = Array.isArray(q.options) ? q.options.map((o) => String(o || '').trim()) : [];
      if (options.length < 2 || options.some((o) => !o)) {
        return { error: `Question ${n}: all options must be filled in` };
      }
      const correctIndex = Number(q.correctIndex);
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
        return { error: `Question ${n}: choose the correct option` };
      }
      out.push({ id: qid, type: 'mcq', text, options, correctIndex, marks });
    }
  }
  return { questions: out };
}

router.post('/quizzes', async (req, res) => {
  const { classId, title, description, questions, durationMinutes, startTime, endTime, negativeMarking, lookAwayStrictness, published } = req.body || {};
  if (!classId || !title) {
    return res.status(400).json({ error: 'classId, title and at least one question are required' });
  }
  const cls = db.classes.findById(classId);
  if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });

  const cleaned = cleanQuestions(questions);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });

  const quiz = {
    id: id(),
    classId,
    teacherId: req.user.id,
    title,
    description: description || '',
    questions: cleaned.questions,
    durationMinutes: durationMinutes || 30,
    startTime: startTime || null,
    endTime: endTime || null,
    negativeMarking: !!negativeMarking,
    lookAwayStrictness: ['low', 'medium', 'high'].includes(lookAwayStrictness) ? lookAwayStrictness : 'medium',
    published: published === true, // publish straight away, or save as draft (default)
    createdAt: new Date().toISOString()
  };
  await db.quizzes.insert(quiz);
  res.status(201).json(quiz);
});

router.get('/quizzes', (req, res) => {
  res.json(db.quizzes.find((q) => q.teacherId === req.user.id));
});

router.get('/quizzes/:id', (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  if (!quiz || quiz.teacherId !== req.user.id) return res.status(404).json({ error: 'Quiz not found' });
  res.json(quiz);
});

router.patch('/quizzes/:id', async (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  if (!quiz || quiz.teacherId !== req.user.id) return res.status(404).json({ error: 'Quiz not found' });
  const allowed = ['title', 'description', 'questions', 'durationMinutes', 'startTime', 'endTime', 'published', 'negativeMarking', 'lookAwayStrictness', 'classId'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('lookAwayStrictness' in patch && !['low', 'medium', 'high'].includes(patch.lookAwayStrictness)) {
    return res.status(400).json({ error: 'lookAwayStrictness must be low, medium or high' });
  }
  if ('questions' in patch) {
    const cleaned = cleanQuestions(patch.questions, new Set(quiz.questions.map((q) => q.id)));
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });
    patch.questions = cleaned.questions;
  }
  if ('classId' in patch) {
    const cls = db.classes.findById(patch.classId);
    if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });
  }
  if ('title' in patch && !String(patch.title || '').trim()) return res.status(400).json({ error: 'Title is required' });
  const updated = await db.quizzes.update(quiz.id, patch);
  res.json(updated);
});

router.delete('/quizzes/:id', async (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  if (!quiz || quiz.teacherId !== req.user.id) return res.status(404).json({ error: 'Quiz not found' });
  // Removes the quiz together with its results, proctoring alerts and images.
  // A copy goes to the recycle bin so the admin can restore it if needed.
  await recycle.trashQuiz(quiz);
  res.json({ ok: true });
});

// ---- Results ---------------------------------------------------------------
router.get('/quizzes/:id/results', (req, res) => {
  const quiz = db.quizzes.findById(req.params.id);
  if (!quiz || quiz.teacherId !== req.user.id) return res.status(404).json({ error: 'Quiz not found' });
  const attempts = db.attempts.find((a) => a.quizId === quiz.id);
  const withNames = attempts.map((a) => {
    const student = db.users.findById(a.studentId);
    return { ...a, studentName: student?.name, studentRoll: student?.rollNumber };
  });
  res.json(withNames);
});

// ---- Attendance ---------------------------------------------------------------
router.post('/attendance', async (req, res) => {
  const { classId, date, records } = req.body || {}; // records: [{studentId, status}]
  const cls = db.classes.findById(classId);
  if (!cls || cls.teacherId !== req.user.id) return res.status(404).json({ error: 'Class not found' });
  const created = [];
  for (const r of records || []) {
    const entry = { id: id(), classId, studentId: r.studentId, date, status: r.status, markedBy: req.user.id };
    await db.attendance.insert(entry);
    created.push(entry);
  }
  res.status(201).json(created);
});

router.get('/attendance', (req, res) => {
  const { classId } = req.query;
  const myClassIds = db.classes.find((c) => c.teacherId === req.user.id).map((c) => c.id);
  const rows = db.attendance.find((a) => myClassIds.includes(a.classId) && (!classId || a.classId === classId));
  res.json(rows);
});

// ---- Proctoring review ---------------------------------------------------------
router.get('/proctoring/events', (req, res) => {
  const { quizId, studentId } = req.query;
  const myQuizIds = db.quizzes.find((q) => q.teacherId === req.user.id).map((q) => q.id);
  let events = db.proctorEvents.find((e) => myQuizIds.includes(e.quizId));
  if (quizId) events = events.filter((e) => e.quizId === quizId);
  if (studentId) events = events.filter((e) => e.studentId === studentId);
  events = events
    .map((e) => ({ ...e, studentName: db.users.findById(e.studentId)?.name }))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(events);
});

// Delete one specific proctoring image. The alert itself stays in the report;
// only the screenshot is removed (and kept in the recycle bin for the admin).
router.delete('/proctoring/events/:id/evidence', async (req, res) => {
  const event = db.proctorEvents.findById(req.params.id);
  const quiz = event && db.quizzes.findById(event.quizId);
  if (!event || !quiz || quiz.teacherId !== req.user.id) return res.status(404).json({ error: 'Alert not found' });
  if (!event.evidenceFile) return res.status(404).json({ error: 'This alert has no image' });
  await recycle.trashImage(event, quiz);
  res.json({ ok: true });
});

module.exports = router;
