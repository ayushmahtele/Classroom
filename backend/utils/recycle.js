/**
 * Recycle bin (soft delete) helpers.
 * ------------------------------------------------------------------
 * Whenever a teacher (or the admin) deletes a class, a quiz or a proctoring
 * image, a snapshot of everything that goes with it is saved to the `trash`
 * collection first, then removed from the live data. The admin can later
 * restore it from there (see routes/admin.js).
 *
 * A trash record looks like:
 *   { id, teacherId, kind: 'class' | 'quiz' | 'image', label, by, deletedAt,
 *     counts: {...}, payload: { classes, quizzes, attempts, proctorEvents,
 *                               attendance, images:[{filename,eventId}] } }
 * Screenshots themselves are moved to the `evidenceTrash` collection (not
 * copied into the record) so a record never gets too big.
 */
const db = require('../db');
const { id } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

// users / enrollments / links are only used when a teacher or student account is removed:
//   users       -> the removed account(s), so they can be re-created
//   enrollments -> [{classId, studentId}] class memberships to put back
//   links       -> [{studentId, teacherId}] student<->teacher links to put back
const emptyPayload = () => ({
  classes: [], quizzes: [], attempts: [], proctorEvents: [], attendance: [], images: [],
  users: [], enrollments: [], links: []
});
const clone = (o) => JSON.parse(JSON.stringify(o));

function countsOf(p) {
  return {
    classes: p.classes.length,
    quizzes: p.quizzes.length,
    attempts: p.attempts.length,
    proctorEvents: p.proctorEvents.length,
    attendance: p.attendance.length,
    images: p.images.length,
    teacherAccounts: (p.users || []).filter((u) => u.role === 'teacher').length,
    studentAccounts: (p.users || []).filter((u) => u.role === 'student').length,
    enrollments: (p.enrollments || []).length
  };
}
function sumCounts(list) {
  const t = { classes: 0, quizzes: 0, attempts: 0, proctorEvents: 0, attendance: 0, images: 0, teacherAccounts: 0, studentAccounts: 0, enrollments: 0 };
  for (const c of list) for (const k of Object.keys(t)) t[k] += c[k] || 0;
  return t;
}

// ---- Collecting what belongs to a quiz / class ---------------------------
function addQuiz(payload, quizId) {
  const quiz = db.quizzes.findById(quizId);
  if (!quiz || payload.quizzes.some((q) => q.id === quiz.id)) return;
  const attempts = db.attempts.find((a) => a.quizId === quizId);
  const attemptIds = new Set(attempts.map((a) => a.id));
  const events = db.proctorEvents.find((e) => e.quizId === quizId || attemptIds.has(e.attemptId));
  payload.quizzes.push(clone(quiz));
  payload.attempts.push(...clone(attempts));
  payload.proctorEvents.push(...clone(events));
  for (const e of events) if (e.evidenceFile) payload.images.push({ filename: e.evidenceFile, eventId: e.id });
}

function addClass(payload, classId) {
  const cls = db.classes.findById(classId);
  if (!cls) return;
  payload.classes.push(clone(cls));
  payload.attendance.push(...clone(db.attendance.find((a) => a.classId === classId)));
  for (const q of db.quizzes.find((q) => q.classId === classId)) addQuiz(payload, q.id);
}

// Image-only payload: the given events' screenshots (the events themselves stay).
function imagesPayload(events) {
  const p = emptyPayload();
  for (const e of events) if (e.evidenceFile) p.images.push({ filename: e.evidenceFile, eventId: e.id });
  return p;
}

// ---- Removing from the live data --------------------------------------------
async function removeLive(kind, p) {
  if (kind === 'image') {
    for (const img of p.images) {
      if (db.proctorEvents.findById(img.eventId)) await db.proctorEvents.update(img.eventId, { evidenceFile: null });
    }
    return;
  }
  await db.proctorEvents.removeMany(p.proctorEvents.map((x) => x.id));
  await db.attempts.removeMany(p.attempts.map((x) => x.id));
  await db.attendance.removeMany(p.attendance.map((x) => x.id));
  await db.quizzes.removeMany(p.quizzes.map((x) => x.id));
  await db.classes.removeMany(p.classes.map((x) => x.id));

  // class memberships of a removed student
  for (const e of p.enrollments || []) {
    const cls = db.classes.findById(e.classId);
    if (cls) await db.classes.update(cls.id, { studentIds: cls.studentIds.filter((sid) => sid !== e.studentId) });
  }
  // student <-> teacher links
  for (const l of p.links || []) {
    const st = db.users.findById(l.studentId);
    if (!st) continue;
    const current = Array.isArray(st.teacherIds) ? st.teacherIds : (st.createdBy === l.teacherId ? [l.teacherId] : []);
    await db.users.update(st.id, { teacherIds: current.filter((t) => t !== l.teacherId) });
  }
  // the removed account(s) themselves
  await db.users.removeMany((p.users || []).map((u) => u.id));
}

/** Delete a unit but keep it recoverable in the recycle bin. */
async function trashUnit({ teacherId, kind, label, by, payload }) {
  const teacherName = (teacherId && db.users.findById(teacherId)?.name) || null; // kept in case the teacher is later removed
  const rec = { id: id(), teacherId: teacherId || null, teacherName, kind, label, by, deletedAt: new Date().toISOString(), counts: countsOf(payload), payload };
  await db.trash.insert(rec);
  for (const img of payload.images) await db.trashEvidence(img.filename, rec.id);
  await removeLive(kind, payload);
  return rec;
}

/** Delete a unit for good (no recycle-bin copy). */
async function eraseUnit({ kind, payload }) {
  await db.deleteEvidence(payload.images.map((i) => i.filename));
  await removeLive(kind, payload);
}

// ---- Teacher-facing helpers ------------------------------------------------------
function trashQuiz(quiz, by = 'teacher') {
  const payload = emptyPayload();
  addQuiz(payload, quiz.id);
  return trashUnit({ teacherId: quiz.teacherId, kind: 'quiz', label: quiz.title, by, payload });
}
function trashClass(cls, by = 'teacher') {
  const payload = emptyPayload();
  addClass(payload, cls.id);
  return trashUnit({ teacherId: cls.teacherId, kind: 'class', label: cls.name, by, payload });
}
function trashImage(event, quiz, by = 'teacher') {
  const student = db.users.findById(event.studentId);
  const label = `${event.type} screenshot — ${quiz?.title || 'quiz'}${student ? ` (${student.name})` : ''}`;
  return trashUnit({ teacherId: quiz.teacherId, kind: 'image', label, by, payload: imagesPayload([event]) });
}

// ---- Removing student / teacher accounts -------------------------------------------
function attemptsAndEvents(payload, attempts, extraEventFilter) {
  const ids = new Set(attempts.map((a) => a.id));
  const events = db.proctorEvents.find((e) => ids.has(e.attemptId) || (extraEventFilter && extraEventFilter(e)));
  payload.attempts.push(...clone(attempts));
  payload.proctorEvents.push(...clone(events));
  for (const e of events) if (e.evidenceFile) payload.images.push({ filename: e.evidenceFile, eventId: e.id });
}

function studentTeacherIds(st) {
  return Array.isArray(st.teacherIds) ? st.teacherIds : (st.createdBy ? [st.createdBy] : []);
}

/** Admin removes a student: the account and everything of theirs, for every teacher. */
function removeStudentByAdmin(student, by = 'admin') {
  const payload = emptyPayload();
  payload.users.push(clone(student));
  attemptsAndEvents(payload, db.attempts.find((a) => a.studentId === student.id), (e) => e.studentId === student.id);
  payload.attendance.push(...clone(db.attendance.find((a) => a.studentId === student.id)));
  for (const c of db.classes.find((c) => c.studentIds.includes(student.id))) payload.enrollments.push({ classId: c.id, studentId: student.id });
  return trashUnit({ teacherId: null, kind: 'admin_student', label: `${student.name} (${student.loginId})`, by, payload });
}

/** Admin removes a teacher: the account and all of their classes, quizzes, results,
 *  attendance and proctoring data. Students stay, but lose the link to this teacher. */
function removeTeacherByAdmin(teacher, by = 'admin') {
  const payload = emptyPayload();
  payload.users.push(clone(teacher));
  for (const c of db.classes.find((c) => c.teacherId === teacher.id)) addClass(payload, c.id);
  for (const q of db.quizzes.find((q) => q.teacherId === teacher.id)) addQuiz(payload, q.id);
  for (const st of db.users.find((u) => u.role === 'student' && studentTeacherIds(u).includes(teacher.id))) {
    payload.links.push({ studentId: st.id, teacherId: teacher.id });
  }
  return trashUnit({ teacherId: teacher.id, kind: 'admin_teacher', label: `${teacher.name} (${teacher.loginId})`, by, payload });
}

/** A teacher removes a student from *their* students only. The student account stays
 *  (other teachers keep them) but loses this teacher's classes, attendance and quiz data. */
function unlinkStudent(teacher, student, by = 'teacher') {
  const payload = emptyPayload();
  const myClasses = db.classes.find((c) => c.teacherId === teacher.id);
  const myClassIds = new Set(myClasses.map((c) => c.id));
  const myQuizIds = new Set(db.quizzes.find((q) => q.teacherId === teacher.id).map((q) => q.id));
  attemptsAndEvents(
    payload,
    db.attempts.find((a) => a.studentId === student.id && myQuizIds.has(a.quizId)),
    (e) => e.studentId === student.id && myQuizIds.has(e.quizId)
  );
  payload.attendance.push(...clone(db.attendance.find((a) => a.studentId === student.id && myClassIds.has(a.classId))));
  for (const c of myClasses) if (c.studentIds.includes(student.id)) payload.enrollments.push({ classId: c.id, studentId: student.id });
  payload.links.push({ studentId: student.id, teacherId: teacher.id });
  return trashUnit({ teacherId: teacher.id, kind: 'student_unlink', label: `${student.name} (${student.loginId})`, by, payload });
}

// ---- Time ranges ------------------------------------------------------------------
// range: number of days back (1, 2, ... 7, 14, 30, ...) or 'all' (everything)
function cutoffFor(range) {
  if (range === 'all' || range === undefined || range === null || range === '') return { cutoff: null };
  const days = Number(range);
  if (!Number.isFinite(days) || days < 1 || days > 3650) return { error: 'Invalid time range' };
  return { cutoff: new Date(Date.now() - days * DAY) };
}

// ---- Admin: bulk delete plan ------------------------------------------------------
function buildDeletePlan(teacherIds, cutoff, cats) {
  const inWindow = (iso) => !cutoff || (iso && new Date(iso) >= cutoff);
  const units = [];
  for (const teacherId of teacherIds) {
    const consumed = new Set(); // quizzes already covered by a class / quiz unit

    if (cats.classes) {
      for (const cls of db.classes.find((c) => c.teacherId === teacherId && inWindow(c.createdAt))) {
        const payload = emptyPayload();
        addClass(payload, cls.id);
        payload.quizzes.forEach((q) => consumed.add(q.id));
        units.push({ teacherId, kind: 'class', label: cls.name, payload });
      }
    }
    if (cats.quizzes) {
      for (const q of db.quizzes.find((q) => q.teacherId === teacherId && inWindow(q.createdAt) && !consumed.has(q.id))) {
        const payload = emptyPayload();
        addQuiz(payload, q.id);
        consumed.add(q.id);
        units.push({ teacherId, kind: 'quiz', label: q.title, payload });
      }
    }
    if (cats.images) {
      for (const q of db.quizzes.find((q) => q.teacherId === teacherId && !consumed.has(q.id))) {
        const events = db.proctorEvents.find((e) => e.quizId === q.id && e.evidenceFile && inWindow(e.timestamp));
        if (!events.length) continue;
        const payload = imagesPayload(events);
        units.push({ teacherId, kind: 'image', label: `${payload.images.length} proctoring image(s) — ${q.title}`, payload });
      }
    }
  }
  return units;
}

async function executeDelete(units, { by, permanent }) {
  for (const u of units) {
    if (permanent) await eraseUnit(u);
    else await trashUnit({ ...u, by });
  }
}

// ---- Restore ------------------------------------------------------------------------
// Order in which a batch is restored (accounts first, single images last)
const KIND_ORDER = { admin_teacher: 0, admin_student: 1, class: 2, quiz: 3, student_unlink: 4, image: 5 };

/** Puts one recycle-bin record back. Returns { ok, reason?, counts?, warnings? } */
async function restoreUnit(rec) {
  const p = rec.payload;
  const kind = rec.kind;
  const warnings = [];
  const fail = (reason) => ({ ok: false, reason });

  if (kind === 'image') {
    if (!p.images.every((i) => db.proctorEvents.findById(i.eventId))) {
      return fail('Its quiz/alert is still deleted — restore that quiz first');
    }
    let n = 0;
    for (const img of p.images) {
      if (await db.restoreEvidence(img.filename)) {
        await db.proctorEvents.update(img.eventId, { evidenceFile: img.filename });
        n++;
      }
    }
    await db.trash.remove(rec.id);
    return { ok: true, counts: { images: n }, warnings };
  }

  const accountKind = kind === 'admin_teacher' || kind === 'admin_student';
  if (!accountKind && !db.users.findById(rec.teacherId)) {
    return fail('The teacher account is removed — restore the teacher first');
  }
  if (kind === 'student_unlink' && !db.users.findById(p.links[0]?.studentId)) {
    return fail('The student account is removed — restore the student first');
  }

  // 1) the account(s)
  const counts = {};
  for (const u of p.users || []) {
    if (db.users.findById(u.id)) continue;
    const clash = db.users.findOne((x) =>
      x.id !== u.id &&
      ((u.email && x.email && x.email.toLowerCase() === u.email.toLowerCase()) || (u.loginId && x.loginId === u.loginId)));
    if (clash) return fail(`Another account already uses ${u.email || u.loginId}`);
    const doc = u.role === 'student' && Array.isArray(u.teacherIds)
      ? { ...u, teacherIds: u.teacherIds.filter((t) => db.users.findById(t)) }
      : u;
    await db.users.insert(doc);
  }
  counts.accounts = (p.users || []).length;

  // 2) the data. When only a student's data comes back, skip anything whose
  //    quiz / class no longer exists (it would just be an orphan).
  const strict = kind === 'admin_student' || kind === 'student_unlink';
  let skipped = 0;
  const pick = (docs, col, ok) => {
    const fresh = (docs || []).filter((d) => !col.findById(d.id));
    const keep = strict ? fresh.filter(ok) : fresh;
    skipped += fresh.length - keep.length;
    return keep;
  };
  counts.classes = await db.classes.insertMany(pick(p.classes, db.classes, () => true));
  counts.quizzes = await db.quizzes.insertMany(pick(p.quizzes, db.quizzes, () => true));
  counts.attempts = await db.attempts.insertMany(pick(p.attempts, db.attempts, (a) => !!db.quizzes.findById(a.quizId)));
  counts.proctorEvents = await db.proctorEvents.insertMany(pick(p.proctorEvents, db.proctorEvents, (e) => !!db.attempts.findById(e.attemptId)));
  counts.attendance = await db.attendance.insertMany(pick(p.attendance, db.attendance, (a) => !!db.classes.findById(a.classId)));
  if (skipped) warnings.push(`${skipped} item(s) of "${rec.label}" were skipped because their quiz or class is still deleted`);

  // 3) class memberships and student<->teacher links
  for (const e of p.enrollments || []) {
    const cls = db.classes.findById(e.classId);
    if (cls && db.users.findById(e.studentId) && !cls.studentIds.includes(e.studentId)) {
      await db.classes.update(cls.id, { studentIds: [...cls.studentIds, e.studentId] });
    }
  }
  for (const l of p.links || []) {
    const st = db.users.findById(l.studentId);
    if (!st || !db.users.findById(l.teacherId)) continue;
    const current = Array.isArray(st.teacherIds) ? st.teacherIds : [];
    if (!current.includes(l.teacherId)) await db.users.update(st.id, { teacherIds: [...current, l.teacherId] });
  }

  // 4) screenshots
  counts.images = 0;
  for (const img of p.images || []) if (await db.restoreEvidence(img.filename)) counts.images++;

  for (const q of p.quizzes || []) {
    if (!db.classes.findById(q.classId)) warnings.push(`Quiz "${q.title}" was restored but its class is still deleted`);
  }
  await db.trash.remove(rec.id);
  return { ok: true, counts, warnings };
}

module.exports = {
  trashQuiz, trashClass, trashImage,
  removeStudentByAdmin, removeTeacherByAdmin, unlinkStudent, KIND_ORDER,
  cutoffFor, buildDeletePlan, executeDelete, restoreUnit,
  countsOf, sumCounts
};
