/**
 * Multi-college (multi-tenant) helpers.
 * ------------------------------------------------------------------
 * Every teacher, student and college admin belongs to exactly one college
 * (`user.collegeId`). Classes, quizzes, attempts, attendance and proctoring
 * data belong to a college through their teacher. The global (bootstrap)
 * admin is the only account without a collegeId.
 *
 * A college record looks like:
 *   { id, name, shortName, status: 'active' | 'suspended', adminId,
 *     rollCounter, createdBy, createdAt }
 *
 * Roll numbers are per college: JIIT1, JIIT2 ... (shortName + running number).
 * `student.rollSeq` keeps the bare number so the label can be rebuilt if the
 * college's short name is ever changed.
 */
const db = require('../db');
const { id } = require('./helpers');

// Words skipped when building a short name: "Jaypee Institute of Information
// Technology" -> "JIIT".
const SKIP_WORDS = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'a', 'an', '&']);

function suggestShortName(name) {
  const words = String(name || '')
    .replace(/[^A-Za-z0-9&\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !SKIP_WORDS.has(w.toLowerCase()));
  return words.map((w) => w[0]).join('').toUpperCase().slice(0, 10);
}

// Names are compared ignoring case, punctuation and extra spaces, so
// "JIIT, Noida" and "jiit noida" count as the same college.
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cleanShort = (s) => String(s || '').trim().toUpperCase();

/** Validates a college name + short name. `exceptId` skips the college being edited. */
function validateCollege({ name, shortName }, exceptId = null) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleanName) return { error: 'College name is required' };
  const short = cleanShort(shortName || suggestShortName(cleanName));
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(short)) {
    return { error: 'Short name must be 2–10 letters/digits and start with a letter (e.g. JIIT)' };
  }
  const others = db.colleges.find((c) => c.id !== exceptId);
  if (others.some((c) => normName(c.name) === normName(cleanName))) {
    return { error: `A college named "${cleanName}" already exists` };
  }
  if (others.some((c) => cleanShort(c.shortName) === short)) {
    return { error: `The short name "${short}" is already used by another college` };
  }
  return { name: cleanName, shortName: short };
}

/** Reserves the next roll number of a college (JIIT1, JIIT2 ...).
 *  The counter is bumped in memory before anything is awaited, so two
 *  simultaneous requests can never get the same number. */
async function assignRollNumber(collegeId) {
  const college = db.colleges.findById(collegeId);
  if (!college) throw new Error('College not found');
  const rollSeq = (Number(college.rollCounter) || 0) + 1;
  college.rollCounter = rollSeq; // cache object -> synchronous reservation
  await db.colleges.update(college.id, { rollCounter: rollSeq });
  return { rollSeq, rollNumber: `${college.shortName}${rollSeq}` };
}

/** Re-labels every student of a college after its short name changed. */
async function relabelRollNumbers(college) {
  for (const s of db.users.find((u) => u.role === 'student' && u.collegeId === college.id)) {
    const seq = Number.isFinite(Number(s.rollSeq)) && s.rollSeq ? Number(s.rollSeq)
      : Number((String(s.rollNumber || '').match(/(\d+)$/) || [])[1]);
    if (seq) await db.users.update(s.id, { rollSeq: seq, rollNumber: `${college.shortName}${seq}` });
  }
}

function collegeOf(user) {
  return user?.collegeId ? db.colleges.findById(user.collegeId) : null;
}

function collegeLabel(collegeId) {
  const c = collegeId && db.colleges.findById(collegeId);
  return c ? `${c.name} (${c.shortName})` : '';
}

/** Ids of every teacher of a college. */
function teacherIdsOf(collegeId) {
  return new Set(db.users.find((u) => u.role === 'teacher' && u.collegeId === collegeId).map((u) => u.id));
}

/** College of a class / quiz / attempt etc., worked out through its teacher. */
function collegeIdOfTeacher(teacherId) {
  return db.users.findById(teacherId)?.collegeId || null;
}

// ---- One-time migration of single-college data ---------------------------
// Before multi-college support every teacher/student belonged to "the" college.
// On startup, any teacher/student without a collegeId is moved into one legacy
// college (name/short name from LEGACY_COLLEGE_NAME / LEGACY_COLLEGE_SHORT, or
// "My College" / "MC"). The global admin can rename it and give it its own
// college admin from Admin -> Colleges. Old numeric roll numbers 1, 2, 3 become
// MC1, MC2, MC3. Safe to run on every start: it only touches unassigned data.
async function migrateToColleges() {
  const orphans = db.users.find((u) => (u.role === 'teacher' || u.role === 'student') && !u.collegeId);
  if (!orphans.length) return;

  const wantedName = process.env.LEGACY_COLLEGE_NAME || 'My College';
  let college = db.colleges.findOne((c) => c.legacy) || db.colleges.findOne((c) => normName(c.name) === normName(wantedName));
  if (!college) {
    let shortName = cleanShort(process.env.LEGACY_COLLEGE_SHORT || suggestShortName(wantedName) || 'MC');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(shortName)) shortName = 'MC';
    while (db.colleges.findOne((c) => cleanShort(c.shortName) === shortName)) shortName = `${shortName}X`.slice(0, 10);
    college = {
      id: id(),
      name: wantedName,
      shortName,
      status: 'active',
      adminId: null,
      rollCounter: 0,
      legacy: true,
      createdBy: null,
      createdAt: new Date().toISOString()
    };
    await db.colleges.insert(college);
  }

  // Teachers first, then students in the order they were created, so old roll
  // numbers keep their order. Existing numeric roll numbers are kept as the seq.
  let counter = Number(college.rollCounter) || 0;
  const students = orphans.filter((u) => u.role === 'student');
  for (const s of students) {
    const n = Number(s.rollNumber);
    if (/^\d+$/.test(String(s.rollNumber || '')) && n > counter) counter = n;
  }
  for (const t of orphans.filter((u) => u.role === 'teacher')) {
    await db.users.update(t.id, { collegeId: college.id });
  }
  const taken = new Set();
  const sorted = [...students].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const s of sorted) {
    let seq = /^\d+$/.test(String(s.rollNumber || '')) ? Number(s.rollNumber) : null;
    if (!seq || taken.has(seq)) seq = ++counter;
    taken.add(seq);
    await db.users.update(s.id, { collegeId: college.id, rollSeq: seq, rollNumber: `${college.shortName}${seq}` });
  }
  college.rollCounter = counter;
  await db.colleges.update(college.id, { rollCounter: counter });

  // Recycle-bin records from before colleges existed belong to the same college.
  const moved = await db.trash.updateMany({ collegeId: { $exists: false } }, { collegeId: college.id });

  console.log('----------------------------------------------------------');
  console.log(`Multi-college migration: moved ${orphans.length} existing teacher/student account(s)`);
  console.log(`and ${moved} recycle-bin record(s) into the college "${college.name}" (${college.shortName}).`);
  console.log('Rename it and create its college admin from Admin -> Colleges.');
  console.log('----------------------------------------------------------');
}

module.exports = {
  suggestShortName, normName, validateCollege, assignRollNumber, relabelRollNumbers,
  collegeOf, collegeLabel, teacherIdsOf, collegeIdOfTeacher, migrateToColleges
};
