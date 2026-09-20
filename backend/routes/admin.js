const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const recycle = require('../utils/recycle');
const { id, tempPassword, readableId, DEPARTMENTS, teacherDepartments, cleanDepartments, nextRollNumber } = require('../utils/helpers');

const router = express.Router();
router.use(authRequired, requireRole('admin'));

// ---- Teachers -------------------------------------------------------
// Admin creates a teacher account from anywhere using the teacher's
// email. A temporary password + login ID are generated and returned
// so the admin can hand/email/WhatsApp it to the teacher. The teacher
// must change the password on first login (mustChangePassword=true).
router.post('/teachers', async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  // One or more departments from CSE / IT / ECE / CIVIL. (`department` is
  // still accepted for older clients.)
  const departments = cleanDepartments(req.body.departments ?? req.body.department);
  if (!departments.length) {
    return res.status(400).json({ error: `Select at least one department (${DEPARTMENTS.join(', ')})` });
  }

  const exists = db.users.findOne((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'A user with this email already exists' });

  const loginId = readableId('TCH');
  const plainPassword = tempPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const teacher = {
    id: id(),
    role: 'teacher',
    name,
    email,
    departments,
    department: departments.join(', '), // kept for backward compatibility
    loginId,
    passwordHash,
    mustChangePassword: true,
    status: 'active',
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(teacher);

  res.status(201).json({
    message: 'Teacher created. Share these credentials with them securely.',
    credentials: { loginId, temporaryPassword: plainPassword, email },
    teacher: { id: teacher.id, name, email, loginId, department: teacher.department, departments, status: 'active' }
  });
});

router.get('/teachers', (req, res) => {
  const teachers = db.users
    .find((u) => u.role === 'teacher')
    .map(({ passwordHash, ...t }) => ({ ...t, departments: teacherDepartments(t) }));
  res.json(teachers);
});

// Remove a teacher completely: the account and all of their classes, quizzes, results,
// attendance and proctoring data. Students stay but lose the link to this teacher.
// Restorable from the recycle bin.
router.delete('/teachers/:id', async (req, res) => {
  const teacher = db.users.findById(req.params.id);
  if (!teacher || teacher.role !== 'teacher') return res.status(404).json({ error: 'Teacher not found' });
  await recycle.removeTeacherByAdmin(teacher);
  res.json({ ok: true });
});

router.patch('/teachers/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or suspended' });
  }
  const updated = await db.users.update(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Teacher not found' });
  res.json({ ok: true });
});

router.post('/teachers/:id/reset-password', async (req, res) => {
  const teacher = db.users.findById(req.params.id);
  if (!teacher || teacher.role !== 'teacher') return res.status(404).json({ error: 'Teacher not found' });
  const plainPassword = tempPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await db.users.update(teacher.id, { passwordHash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: plainPassword });
});

// ---- Platform-wide stats & oversight ---------------------------------
router.get('/stats', (req, res) => {
  const users = db.users.all();
  res.json({
    teachers: users.filter((u) => u.role === 'teacher').length,
    students: users.filter((u) => u.role === 'student').length,
    classes: db.classes.all().length,
    quizzes: db.quizzes.all().length,
    attempts: db.attempts.all().length,
    proctorAlerts: db.proctorEvents.all().length
  });
});

// Admin creates a student, gives it a domain and chooses which teachers get it:
//   assignMode 'selected' -> only the teachers listed in teacherIds
//   assignMode 'domain'   -> every teacher whose departments include the student's domain
//   assignMode 'all'      -> every teacher, whatever their department
// The roll number is generated automatically (1, 2, 3 ...).
router.post('/students', async (req, res) => {
  const { name, email, department, assignMode, teacherIds } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const domain = String(department || '').trim().toUpperCase();
  if (!DEPARTMENTS.includes(domain)) {
    return res.status(400).json({ error: `Student domain must be one of ${DEPARTMENTS.join(', ')}` });
  }
  if (!['selected', 'domain', 'all'].includes(assignMode)) {
    return res.status(400).json({ error: 'Choose who to add this student to' });
  }

  const exists = db.users.findOne((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'A user with this email already exists' });

  const allTeachers = db.users.find((u) => u.role === 'teacher');
  let targets;
  if (assignMode === 'selected') {
    const wanted = new Set(Array.isArray(teacherIds) ? teacherIds : []);
    targets = allTeachers.filter((t) => wanted.has(t.id));
    if (!targets.length) return res.status(400).json({ error: 'Select at least one teacher' });
  } else if (assignMode === 'domain') {
    targets = allTeachers.filter((t) => teacherDepartments(t).includes(domain));
    if (!targets.length) return res.status(400).json({ error: `There are no ${domain} teachers yet` });
  } else {
    targets = allTeachers;
    if (!targets.length) return res.status(400).json({ error: 'There are no teachers yet' });
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
    rollNumber: nextRollNumber(db.users.all()),
    loginId,
    passwordHash,
    mustChangePassword: true,
    status: 'active',
    teacherIds: targets.map((t) => t.id),
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(student);

  res.status(201).json({
    message: 'Student created. Share these credentials with them securely.',
    credentials: { loginId, temporaryPassword: plainPassword, email },
    student: { id: student.id, name, email, loginId, department: domain, rollNumber: student.rollNumber },
    assignedTeachers: targets.map((t) => t.name)
  });
});

// Remove a student completely: the account, and their attempts, proctoring data,
// attendance and class memberships under every teacher. Restorable from the recycle bin.
router.delete('/students/:id', async (req, res) => {
  const student = db.users.findById(req.params.id);
  if (!student || student.role !== 'student') return res.status(404).json({ error: 'Student not found' });
  await recycle.removeStudentByAdmin(student);
  res.json({ ok: true });
});

router.post('/students/:id/reset-password', async (req, res) => {
  const student = db.users.findById(req.params.id);
  if (!student || student.role !== 'student') return res.status(404).json({ error: 'Student not found' });
  const plainPassword = tempPassword();
  const passwordHash = await bcrypt.hash(plainPassword, 10);
  await db.users.update(student.id, { passwordHash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: plainPassword });
});

router.get('/students', (req, res) => {
  const teachers = db.users.find((u) => u.role === 'teacher');
  const students = db.users.find((u) => u.role === 'student').map(({ passwordHash, ...s }) => ({
    ...s,
    teacherNames: teachers
      .filter((t) => (Array.isArray(s.teacherIds) ? s.teacherIds.includes(t.id) : s.createdBy === t.id))
      .map((t) => t.name)
  }));
  res.json(students);
});

// ==== Restore data / Delete data ============================================
// Both work on "all teachers" or on one or more chosen teachers, and take a
// time range: a number of days back (1, 2, ... 7, 14, 30 ...) or 'all'.

function resolveTeachers(scope, teacherIds) {
  const all = db.users.find((u) => u.role === 'teacher');
  if (scope === 'all') return { teachers: all };
  if (scope === 'selected') {
    const wanted = new Set(Array.isArray(teacherIds) ? teacherIds : []);
    const teachers = all.filter((t) => wanted.has(t.id));
    if (!teachers.length) return { error: 'Select at least one teacher' };
    return { teachers };
  }
  return { error: 'Choose all teachers or selected teachers' };
}

// Query the recycle bin (what was deleted, by which teacher, when)
async function findTrash(scope, teacherIds, range) {
  const r = recycle.cutoffFor(range);
  if (r.error) return { error: r.error };
  let query;
  if (scope === 'admin') {
    // the admin's own work: students / teachers the admin has removed
    query = { kind: { $in: ['admin_student', 'admin_teacher'] } };
  } else {
    const t = resolveTeachers(scope, teacherIds);
    if (t.error) return { error: t.error };
    query = { teacherId: { $in: t.teachers.map((x) => x.id) } };
  }
  if (r.cutoff) query.deletedAt = { $gte: r.cutoff.toISOString() };
  return { rows: await db.trash.list(query) };
}

router.get('/trash', async (req, res) => {
  const { scope, range } = req.query;
  const teacherIds = String(req.query.teacherIds || '').split(',').filter(Boolean);
  const found = await findTrash(scope, teacherIds, range);
  if (found.error) return res.status(400).json({ error: found.error });
  const names = Object.fromEntries(db.users.find((u) => u.role === 'teacher').map((t) => [t.id, t.name]));
  const items = found.rows.map((r) => ({
    id: r.id, kind: r.kind, label: r.label, teacherId: r.teacherId,
    teacherName: names[r.teacherId] || r.teacherName || '—', deletedAt: r.deletedAt, by: r.by, counts: r.counts
  }));
  res.json({ items, totals: recycle.sumCounts(items.map((i) => i.counts)) });
});

router.post('/trash/restore', async (req, res) => {
  const { scope, teacherIds, range, ids } = req.body || {};
  let rows;
  if (Array.isArray(ids) && ids.length) {
    rows = [];
    for (const rid of ids) { const r = await db.trash.get(rid); if (r) rows.push(r); }
  } else {
    const found = await findTrash(scope, teacherIds, range);
    if (found.error) return res.status(400).json({ error: found.error });
    rows = [];
    for (const r of found.rows) rows.push(await db.trash.get(r.id));
  }
  // accounts first, then classes/quizzes, single images last (each needs the one before it)
  rows.sort((a, b) => (recycle.KIND_ORDER[a.kind] ?? 9) - (recycle.KIND_ORDER[b.kind] ?? 9));

  const restored = [];
  const skipped = [];
  const warnings = [];
  for (const rec of rows) {
    const r = await recycle.restoreUnit(rec);
    if (r.ok) { restored.push(rec.label); warnings.push(...r.warnings); }
    else skipped.push({ label: rec.label, reason: r.reason });
  }
  res.json({ restoredCount: restored.length, restored, skipped, warnings });
});

// Delete data. `dryRun: true` only counts what would be deleted.
// By default everything goes to the recycle bin (restorable);
// `permanent: true` erases it for good.
router.post('/data/delete', async (req, res) => {
  const { scope, teacherIds, range, categories, permanent, dryRun } = req.body || {};
  const t = resolveTeachers(scope, teacherIds);
  if (t.error) return res.status(400).json({ error: t.error });
  const r = recycle.cutoffFor(range);
  if (r.error) return res.status(400).json({ error: r.error });
  const cats = {
    classes: !!categories?.classes,
    quizzes: !!categories?.quizzes,
    images: !!categories?.images
  };
  if (!cats.classes && !cats.quizzes && !cats.images) return res.status(400).json({ error: 'Choose what to delete' });

  const units = recycle.buildDeletePlan(t.teachers.map((x) => x.id), r.cutoff, cats);
  const totals = recycle.sumCounts(units.map((u) => recycle.countsOf(u.payload)));
  if (dryRun) return res.json({ dryRun: true, units: units.length, totals });

  await recycle.executeDelete(units, { by: 'admin', permanent: !!permanent });
  res.json({ ok: true, units: units.length, totals, permanent: !!permanent });
});

module.exports = router;
