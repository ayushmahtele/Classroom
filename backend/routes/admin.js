/**
 * Admin API — used by BOTH kinds of admin (they log in from the same Admin tab):
 *
 *  - Global (platform) admin: the bootstrap admin, has no collegeId. Sees and
 *    manages every college. Creates colleges, each with one college admin.
 *  - College admin: has a collegeId. Sees and manages only their own college;
 *    everything they create is put in their college automatically.
 *
 * `adminScope` (middleware/auth.js) sets req.isGlobal / req.collegeId.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, requireRole, adminScope, requireGlobalAdmin } = require('../middleware/auth');
const recycle = require('../utils/recycle');
const { id, tempPassword, uniqueLoginId, DEPARTMENTS, teacherDepartments, cleanDepartments } = require('../utils/helpers');
const { validateCollege, assignRollNumber, relabelRollNumbers } = require('../utils/college');

const router = express.Router();
router.use(authRequired, requireRole('admin'), adminScope);

// ---- Scope helpers -----------------------------------------------------------
const inScope = (req, user) => req.isGlobal || (user && user.collegeId === req.collegeId);

function findMember(req, userId, role) {
  const u = db.users.findById(userId);
  if (!u || u.role !== role || !inScope(req, u)) return null;
  return u;
}

/** The college a new teacher/student goes into: picked by the global admin,
 *  always the admin's own college for a college admin. */
function targetCollege(req, collegeId) {
  const cid = req.isGlobal ? collegeId : req.collegeId;
  if (!cid) return { error: 'Select a college' };
  const college = db.colleges.findById(cid);
  if (!college) return { error: 'College not found' };
  return { college };
}

/** For list/filter endpoints: the global admin may pass ?collegeId= (or 'all'). */
function filterCollegeId(req, requested) {
  if (!req.isGlobal) return req.collegeId;
  return requested && requested !== 'all' ? requested : null;
}

const deletedBy = (req) => (req.isGlobal ? 'global' : 'college_admin');
const collegeMap = () => Object.fromEntries(db.colleges.all().map((c) => [c.id, c]));
const emailTaken = (email) => !!db.users.findOne((u) => u.email?.toLowerCase() === String(email).toLowerCase());
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

async function newPassword() {
  const plain = tempPassword();
  return { plain, hash: await bcrypt.hash(plain, 10) };
}

// ---- Who am I ------------------------------------------------------------------
router.get('/me', (req, res) => {
  const me = db.users.findById(req.user.id);
  const college = req.collegeId ? db.colleges.findById(req.collegeId) : null;
  res.json({
    isGlobal: req.isGlobal,
    name: me.name,
    loginId: me.loginId,
    email: me.email,
    college: college ? { id: college.id, name: college.name, shortName: college.shortName } : null,
    departments: DEPARTMENTS
  });
});

// ==== Colleges (global admin only) ==============================================
function collegeAdminAccount(college) {
  return college.adminId ? db.users.findById(college.adminId) : null;
}

function collegeSummary(c) {
  const members = db.users.find((u) => u.collegeId === c.id);
  const admin = collegeAdminAccount(c);
  return {
    id: c.id,
    name: c.name,
    shortName: c.shortName,
    status: c.status || 'active',
    createdAt: c.createdAt,
    teachers: members.filter((u) => u.role === 'teacher').length,
    students: members.filter((u) => u.role === 'student').length,
    nextRollNumber: `${c.shortName}${(Number(c.rollCounter) || 0) + 1}`,
    admin: admin ? { id: admin.id, name: admin.name, email: admin.email, loginId: admin.loginId, resetRequested: admin.resetRequested || null } : null
  };
}

router.get('/colleges', requireGlobalAdmin, (req, res) => {
  res.json(db.colleges.all().map(collegeSummary).sort((a, b) => a.name.localeCompare(b.name)));
});

async function createCollegeAdmin(req, college, adminName, adminEmail) {
  const loginId = uniqueLoginId('ADM', db.users.all());
  const pw = await newPassword();
  const admin = {
    id: id(),
    role: 'admin',
    name: adminName,
    email: adminEmail,
    loginId,
    passwordHash: pw.hash,
    mustChangePassword: true,
    status: 'active',
    collegeId: college.id,
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(admin);
  await db.colleges.update(college.id, { adminId: admin.id });
  return { loginId, temporaryPassword: pw.plain, email: adminEmail };
}

// Add a college together with its one college admin account.
router.post('/colleges', requireGlobalAdmin, async (req, res) => {
  const { name, shortName, adminName, adminEmail } = req.body || {};
  const v = validateCollege({ name, shortName });
  if (v.error) return res.status(400).json({ error: v.error });
  if (!String(adminName || '').trim()) return res.status(400).json({ error: "College admin's name is required" });
  if (!isEmail(adminEmail)) return res.status(400).json({ error: "Enter a valid email for the college admin" });
  if (emailTaken(adminEmail)) return res.status(409).json({ error: 'A user with this email already exists' });

  const college = {
    id: id(),
    name: v.name,
    shortName: v.shortName,
    status: 'active',
    adminId: null,
    rollCounter: 0,
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.colleges.insert(college);
  const credentials = await createCollegeAdmin(req, college, String(adminName).trim(), String(adminEmail).trim());
  res.status(201).json({
    message: 'College created. Share the college admin credentials securely.',
    college: collegeSummary(db.colleges.findById(college.id)),
    credentials
  });
});

// Edit a college's name / short name, and its admin's name / email.
// Changing the short name re-labels the roll numbers (JIIT7 -> JIITN7).
router.patch('/colleges/:id', requireGlobalAdmin, async (req, res) => {
  const college = db.colleges.findById(req.params.id);
  if (!college) return res.status(404).json({ error: 'College not found' });
  const body = req.body || {};
  const v = validateCollege({ name: body.name ?? college.name, shortName: body.shortName ?? college.shortName }, college.id);
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = collegeAdminAccount(college);
  if (admin && (body.adminName !== undefined || body.adminEmail !== undefined)) {
    const patch = {};
    if (body.adminName !== undefined) {
      if (!String(body.adminName).trim()) return res.status(400).json({ error: "College admin's name is required" });
      patch.name = String(body.adminName).trim();
    }
    if (body.adminEmail !== undefined && String(body.adminEmail).toLowerCase() !== String(admin.email).toLowerCase()) {
      if (!isEmail(body.adminEmail)) return res.status(400).json({ error: 'Enter a valid email for the college admin' });
      if (emailTaken(body.adminEmail)) return res.status(409).json({ error: 'A user with this email already exists' });
      patch.email = String(body.adminEmail).trim();
    }
    if (Object.keys(patch).length) await db.users.update(admin.id, patch);
  }

  const shortChanged = v.shortName !== college.shortName;
  const updated = await db.colleges.update(college.id, { name: v.name, shortName: v.shortName, legacy: false });
  if (shortChanged) await relabelRollNumbers(updated);
  res.json(collegeSummary(updated));
});

// A college without an admin (e.g. the one created for your pre-existing data,
// or after the admin account was lost) gets a new admin account here.
router.post('/colleges/:id/admin', requireGlobalAdmin, async (req, res) => {
  const college = db.colleges.findById(req.params.id);
  if (!college) return res.status(404).json({ error: 'College not found' });
  if (collegeAdminAccount(college)) return res.status(409).json({ error: 'This college already has an admin' });
  const { adminName, adminEmail } = req.body || {};
  if (!String(adminName || '').trim()) return res.status(400).json({ error: "College admin's name is required" });
  if (!isEmail(adminEmail)) return res.status(400).json({ error: 'Enter a valid email for the college admin' });
  if (emailTaken(adminEmail)) return res.status(409).json({ error: 'A user with this email already exists' });
  const credentials = await createCollegeAdmin(req, college, String(adminName).trim(), String(adminEmail).trim());
  res.status(201).json({ credentials });
});

// Suspend / reactivate a whole college: its admin, teachers and students can't
// sign in (or keep using an open session) while it is suspended. No data is deleted.
router.patch('/colleges/:id/status', requireGlobalAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be active or suspended' });
  const updated = await db.colleges.update(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'College not found' });
  res.json({ ok: true });
});

router.post('/colleges/:id/reset-password', requireGlobalAdmin, async (req, res) => {
  const college = db.colleges.findById(req.params.id);
  const admin = college && collegeAdminAccount(college);
  if (!admin) return res.status(404).json({ error: 'This college has no admin account' });
  const pw = await newPassword();
  await db.users.update(admin.id, { passwordHash: pw.hash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: pw.plain });
});

// Remove a college: the college, its admin, all teachers and students, and every
// class, quiz, result, attendance record and proctoring alert/image of it.
// Restorable by the global admin from Restore Data -> Admin's removals.
router.delete('/colleges/:id', requireGlobalAdmin, async (req, res) => {
  const college = db.colleges.findById(req.params.id);
  if (!college) return res.status(404).json({ error: 'College not found' });
  const rec = await recycle.removeCollege(college, 'global');
  res.json({ ok: true, counts: rec.counts });
});

// ==== Teachers ==================================================================
// A temporary password + login ID are generated and returned so the admin can
// hand them to the teacher, who must change the password on first login.
router.post('/teachers', async (req, res) => {
  const { name, email, collegeId } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const t = targetCollege(req, collegeId);
  if (t.error) return res.status(400).json({ error: t.error });

  // One or more departments from CSE / IT / ECE / CIVIL. (`department` is
  // still accepted for older clients.)
  const departments = cleanDepartments(req.body.departments ?? req.body.department);
  if (!departments.length) {
    return res.status(400).json({ error: `Select at least one department (${DEPARTMENTS.join(', ')})` });
  }
  if (emailTaken(email)) return res.status(409).json({ error: 'A user with this email already exists' });

  const loginId = uniqueLoginId('TCH', db.users.all());
  const pw = await newPassword();
  const teacher = {
    id: id(),
    role: 'teacher',
    name,
    email,
    departments,
    department: departments.join(', '), // kept for backward compatibility
    loginId,
    passwordHash: pw.hash,
    mustChangePassword: true,
    status: 'active',
    collegeId: t.college.id,
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(teacher);

  res.status(201).json({
    message: 'Teacher created. Share these credentials with them securely.',
    credentials: { loginId, temporaryPassword: pw.plain, email },
    teacher: { id: teacher.id, name, email, loginId, department: teacher.department, departments, status: 'active', collegeName: t.college.name }
  });
});

router.get('/teachers', (req, res) => {
  const cid = filterCollegeId(req, req.query.collegeId);
  const colleges = collegeMap();
  const teachers = db.users
    .find((u) => u.role === 'teacher' && (!cid || u.collegeId === cid))
    .map(({ passwordHash, ...t }) => ({
      ...t,
      departments: teacherDepartments(t),
      collegeName: colleges[t.collegeId]?.name || '-',
      collegeShort: colleges[t.collegeId]?.shortName || ''
    }));
  res.json(teachers);
});

// Remove a teacher completely: the account and all of their classes, quizzes, results,
// attendance and proctoring data. Students stay but lose the link to this teacher.
// Restorable from the recycle bin.
router.delete('/teachers/:id', async (req, res) => {
  const teacher = findMember(req, req.params.id, 'teacher');
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
  await recycle.removeTeacherByAdmin(teacher, deletedBy(req));
  res.json({ ok: true });
});

router.patch('/teachers/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be active or suspended' });
  const teacher = findMember(req, req.params.id, 'teacher');
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
  await db.users.update(teacher.id, { status });
  res.json({ ok: true });
});

router.post('/teachers/:id/reset-password', async (req, res) => {
  const teacher = findMember(req, req.params.id, 'teacher');
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
  const pw = await newPassword();
  await db.users.update(teacher.id, { passwordHash: pw.hash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: pw.plain });
});

// ==== Stats ========================================================================
function statsFor(collegeId) {
  const users = collegeId ? db.users.find((u) => u.collegeId === collegeId) : db.users.all();
  if (!collegeId) {
    return {
      teachers: users.filter((u) => u.role === 'teacher').length,
      students: users.filter((u) => u.role === 'student').length,
      classes: db.classes.all().length,
      quizzes: db.quizzes.all().length,
      attempts: db.attempts.all().length,
      proctorAlerts: db.proctorEvents.all().length
    };
  }
  const teacherIds = new Set(users.filter((u) => u.role === 'teacher').map((u) => u.id));
  const quizIds = new Set(db.quizzes.find((q) => teacherIds.has(q.teacherId)).map((q) => q.id));
  return {
    teachers: teacherIds.size,
    students: users.filter((u) => u.role === 'student').length,
    classes: db.classes.find((c) => teacherIds.has(c.teacherId)).length,
    quizzes: quizIds.size,
    attempts: db.attempts.find((a) => quizIds.has(a.quizId)).length,
    proctorAlerts: db.proctorEvents.find((e) => quizIds.has(e.quizId)).length
  };
}

router.get('/stats', (req, res) => {
  if (!req.isGlobal) return res.json(statsFor(req.collegeId));
  const colleges = db.colleges.all();
  res.json({
    colleges: colleges.length,
    ...statsFor(null),
    perCollege: colleges
      .map((c) => ({ id: c.id, name: c.name, shortName: c.shortName, status: c.status || 'active', ...statsFor(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  });
});

// ==== My Info (college admin) ======================================================
// The college admin's own account details and their college's details.
router.get('/my-info', (req, res) => {
  if (req.isGlobal) return res.status(400).json({ error: 'My Info is for college admins' });
  const me = db.users.findById(req.user.id);
  const c = db.colleges.findById(req.collegeId);
  if (!me || !c) return res.status(404).json({ error: 'Not found' });
  res.json({
    adminId: me.loginId,
    name: me.name,
    email: me.email,
    createdAt: me.createdAt || null,
    college: {
      name: c.name,
      shortName: c.shortName,
      status: c.status || 'active',
      createdAt: c.createdAt || null,
      nextRollNumber: `${c.shortName}${(Number(c.rollCounter) || 0) + 1}`
    },
    stats: statsFor(req.collegeId)
  });
});

// ==== Students ======================================================================
// Admin creates a student, gives it a domain and chooses which teachers (of the
// student's college) get it:
//   assignMode 'selected' -> only the teachers listed in teacherIds
//   assignMode 'domain'   -> every teacher of the college whose departments include the domain
//   assignMode 'all'      -> every teacher of the college, whatever their department
//   assignMode 'none'     -> no teacher yet; teachers can pick the student later
// The roll number is generated automatically per college (JIIT1, JIIT2 ...).
router.post('/students', async (req, res) => {
  const { name, email, department, assignMode, teacherIds, collegeId } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const t = targetCollege(req, collegeId);
  if (t.error) return res.status(400).json({ error: t.error });
  const domain = String(department || '').trim().toUpperCase();
  if (!DEPARTMENTS.includes(domain)) {
    return res.status(400).json({ error: `Student domain must be one of ${DEPARTMENTS.join(', ')}` });
  }
  if (!['selected', 'domain', 'all', 'none'].includes(assignMode)) {
    return res.status(400).json({ error: 'Choose who to add this student to' });
  }
  if (emailTaken(email)) return res.status(409).json({ error: 'A user with this email already exists' });

  const collegeTeachers = db.users.find((u) => u.role === 'teacher' && u.collegeId === t.college.id);
  let targets = [];
  if (assignMode === 'selected') {
    const wanted = new Set(Array.isArray(teacherIds) ? teacherIds : []);
    targets = collegeTeachers.filter((x) => wanted.has(x.id));
    if (!targets.length) return res.status(400).json({ error: 'Select at least one teacher of this college' });
  } else if (assignMode === 'domain') {
    targets = collegeTeachers.filter((x) => teacherDepartments(x).includes(domain));
    if (!targets.length) return res.status(400).json({ error: `This college has no ${domain} teachers yet` });
  } else if (assignMode === 'all') {
    targets = collegeTeachers;
    if (!targets.length) return res.status(400).json({ error: 'This college has no teachers yet' });
  }

  const loginId = uniqueLoginId('STU', db.users.all());
  const pw = await newPassword();
  const roll = await assignRollNumber(t.college.id);
  const student = {
    id: id(),
    role: 'student',
    name,
    email,
    department: domain,
    rollNumber: roll.rollNumber,
    rollSeq: roll.rollSeq,
    loginId,
    passwordHash: pw.hash,
    mustChangePassword: true,
    status: 'active',
    collegeId: t.college.id,
    teacherIds: targets.map((x) => x.id),
    createdBy: req.user.id,
    createdAt: new Date().toISOString()
  };
  await db.users.insert(student);

  res.status(201).json({
    message: 'Student created. Share these credentials with them securely.',
    credentials: { loginId, temporaryPassword: pw.plain, email },
    student: { id: student.id, name, email, loginId, department: domain, rollNumber: student.rollNumber, collegeName: t.college.name },
    assignedTeachers: targets.map((x) => x.name)
  });
});

// Remove a student completely: the account, and their attempts, proctoring data,
// attendance and class memberships under every teacher. Restorable from the recycle bin.
router.delete('/students/:id', async (req, res) => {
  const student = findMember(req, req.params.id, 'student');
  if (!student) return res.status(404).json({ error: 'Student not found' });
  await recycle.removeStudentByAdmin(student, deletedBy(req));
  res.json({ ok: true });
});

// Suspend / reactivate a student. A suspended student can't sign in; nothing is deleted.
router.patch('/students/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be active or suspended' });
  const student = findMember(req, req.params.id, 'student');
  if (!student) return res.status(404).json({ error: 'Student not found' });
  await db.users.update(student.id, { status });
  res.json({ ok: true });
});

router.post('/students/:id/reset-password', async (req, res) => {
  const student = findMember(req, req.params.id, 'student');
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const pw = await newPassword();
  await db.users.update(student.id, { passwordHash: pw.hash, mustChangePassword: true, resetRequested: null });
  res.json({ temporaryPassword: pw.plain });
});

router.get('/students', (req, res) => {
  const cid = filterCollegeId(req, req.query.collegeId);
  const colleges = collegeMap();
  const teachers = db.users.find((u) => u.role === 'teacher');
  const students = db.users
    .find((u) => u.role === 'student' && (!cid || u.collegeId === cid))
    .map(({ passwordHash, ...s }) => ({
      ...s,
      status: s.status || 'active',
      collegeName: colleges[s.collegeId]?.name || '-',
      collegeShort: colleges[s.collegeId]?.shortName || '',
      teacherNames: teachers
        .filter((t) => (Array.isArray(s.teacherIds) ? s.teacherIds.includes(t.id) : s.createdBy === t.id))
        .map((t) => t.name)
    }))
    .sort((a, b) => (a.collegeName.localeCompare(b.collegeName)) || ((a.rollSeq || 0) - (b.rollSeq || 0)));
  res.json(students);
});

// ==== Restore data / Delete data ============================================
// Global admin: first pick a college (or all colleges), then all teachers or
// selected teacher(s). College admin: always their own college.
// Time range: a number of days back (1, 2, ... 7, 14, 30 ...) or 'all'.

function resolveTeachers(req, collegeId, scope, teacherIds) {
  const cid = filterCollegeId(req, collegeId);
  const pool = db.users.find((u) => u.role === 'teacher' && (!cid || u.collegeId === cid));
  if (scope === 'all') return { teachers: pool, collegeId: cid };
  if (scope === 'selected') {
    const wanted = new Set(Array.isArray(teacherIds) ? teacherIds : []);
    const teachers = pool.filter((t) => wanted.has(t.id));
    if (!teachers.length) return { error: 'Select at least one teacher' };
    return { teachers, collegeId: cid };
  }
  return { error: 'Choose all teachers or selected teachers' };
}

const ADMIN_KINDS = ['admin_student', 'admin_teacher', 'admin_college'];

// Query the recycle bin (what was deleted, by whom, when)
async function findTrash(req, { collegeId, scope, teacherIds, range }) {
  const r = recycle.cutoffFor(range);
  if (r.error) return { error: r.error };
  if (req.isGlobal && collegeId && collegeId !== 'all' && !db.colleges.findById(collegeId)) {
    return { error: 'College not found' };
  }
  const cid = filterCollegeId(req, collegeId);
  const query = {};
  if (cid) query.collegeId = cid;
  if (scope === 'admin') {
    // accounts / colleges removed by an admin
    query.kind = { $in: ADMIN_KINDS };
  } else if (scope === 'college_admin') {
    // EVERYTHING the college admin deleted: teachers, students, classes, quizzes, images
    query.by = 'college_admin';
  } else if (scope === 'all') {
    // everything a teacher's data was involved in (incl. teachers removed since)
    query.teacherId = { $ne: null };
  } else if (scope === 'selected') {
    const t = resolveTeachers(req, collegeId, 'selected', teacherIds);
    if (t.error) return { error: t.error };
    query.teacherId = { $in: t.teachers.map((x) => x.id) };
  } else {
    return { error: 'Choose what to restore' };
  }
  if (r.cutoff) query.deletedAt = { $gte: r.cutoff.toISOString() };

  // A college admin can't restore what the global admin deleted, nor what they
  // deleted "permanently" themselves (only the global admin can bring that back).
  let hiddenGlobal = 0;
  if (!req.isGlobal) {
    const total = (await db.trash.list(query)).length;
    if (!query.by) query.by = { $nin: ['global', 'admin'] };
    query.hiddenFromCollege = { $ne: true };
    const rows = await db.trash.list(query);
    hiddenGlobal = total - rows.length;
    return { rows, hiddenGlobal };
  }
  return { rows: await db.trash.list(query), hiddenGlobal };
}

/** May this admin restore this recycle-bin record? */
function canRestore(req, rec) {
  if (req.isGlobal) return true;
  return rec.collegeId === req.collegeId && !recycle.isGlobalDeletion(rec.by) && !rec.hiddenFromCollege;
}

const byLabel = (r) => (recycle.isGlobalDeletion(r.by) ? 'Global admin'
  : r.by === 'college_admin' ? (r.hiddenFromCollege ? 'College admin (permanent)' : 'College admin') : 'Teacher');

router.get('/trash', async (req, res) => {
  const { collegeId, scope, range } = req.query;
  const teacherIds = String(req.query.teacherIds || '').split(',').filter(Boolean);
  const found = await findTrash(req, { collegeId, scope, teacherIds, range });
  if (found.error) return res.status(400).json({ error: found.error });
  const names = Object.fromEntries(db.users.find((u) => u.role === 'teacher').map((t) => [t.id, t.name]));
  const colleges = collegeMap();
  const items = found.rows.map((r) => ({
    id: r.id, kind: r.kind, label: r.label, teacherId: r.teacherId,
    teacherName: names[r.teacherId] || r.teacherName || '—',
    collegeName: colleges[r.collegeId]?.name || (r.kind === 'admin_college' ? r.label : '—'),
    deletedAt: r.deletedAt, by: r.by, byLabel: byLabel(r), counts: r.counts
  }));
  res.json({ items, totals: recycle.sumCounts(items.map((i) => i.counts)), hiddenGlobal: found.hiddenGlobal });
});

router.post('/trash/restore', async (req, res) => {
  const { collegeId, scope, teacherIds, range, ids } = req.body || {};
  let rows = [];
  if (Array.isArray(ids) && ids.length) {
    for (const rid of ids) { const r = await db.trash.get(rid); if (r) rows.push(r); }
  } else {
    const found = await findTrash(req, { collegeId, scope, teacherIds, range });
    if (found.error) return res.status(400).json({ error: found.error });
    for (const r of found.rows) rows.push(await db.trash.get(r.id));
  }
  const skipped = [];
  rows = rows.filter((r) => {
    if (r && canRestore(req, r)) return true;
    if (r) skipped.push({ label: r.label, reason: 'Only the global admin can restore this' });
    return false;
  });
  // colleges and accounts first, then classes/quizzes, single images last (each needs the one before it)
  rows.sort((a, b) => (recycle.KIND_ORDER[a.kind] ?? 9) - (recycle.KIND_ORDER[b.kind] ?? 9));

  const restored = [];
  const warnings = [];
  for (const rec of rows) {
    const r = await recycle.restoreUnit(rec);
    if (r.ok) { restored.push(rec.label); warnings.push(...r.warnings); }
    else skipped.push({ label: rec.label, reason: r.reason });
  }
  res.json({ restoredCount: restored.length, restored, skipped, warnings });
});

// Delete data. `dryRun: true` only counts what would be deleted.
// Normally everything goes to the recycle bin (restorable).
// `permanent: true`:
//   - global admin  -> erased for good
//   - college admin -> gone for the college admin (they can't see or restore it),
//                      but still kept for the global admin, who can restore it
router.post('/data/delete', async (req, res) => {
  const { collegeId, scope, teacherIds, range, categories, permanent, dryRun } = req.body || {};
  if (req.isGlobal && collegeId && collegeId !== 'all' && !db.colleges.findById(collegeId)) {
    return res.status(400).json({ error: 'College not found' });
  }
  const t = resolveTeachers(req, collegeId, scope, teacherIds);
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

  await recycle.executeDelete(units, {
    by: deletedBy(req),
    permanent: !!permanent && req.isGlobal,
    hiddenFromCollege: !!permanent && !req.isGlobal
  });
  res.json({ ok: true, units: units.length, totals, permanent: !!permanent });
});

module.exports = router;
