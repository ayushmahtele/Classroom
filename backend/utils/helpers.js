const { v4: uuid } = require('uuid');

function id() {
  return uuid();
}

/** Generates a readable temporary password like "Tq7f-Kp2x" */
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let a = '';
  let b = '';
  for (let i = 0; i < 4; i++) a += chars[Math.floor(Math.random() * chars.length)];
  for (let i = 0; i < 4; i++) b += chars[Math.floor(Math.random() * chars.length)];
  return `${a}-${b}`;
}

function readableId(prefix) {
  return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
}

/** A login ID (e.g. STU2048) that no other account already uses. Falls back to
 *  5, then 6 digits if the 4-digit space for that prefix is getting crowded. */
function uniqueLoginId(prefix, users) {
  const taken = new Set(users.map((u) => String(u.loginId || '').toUpperCase()));
  for (let digits = 4; digits <= 8; digits++) {
    for (let i = 0; i < 40; i++) {
      const min = 10 ** (digits - 1);
      const candidate = `${prefix}${Math.floor(min + Math.random() * 9 * min)}`;
      if (!taken.has(candidate.toUpperCase())) return candidate;
    }
  }
  throw new Error('Could not generate a unique login ID');
}

// Departments (domains) a teacher can belong to and a student can be in.
const DEPARTMENTS = ['CSE', 'IT', 'ECE', 'CIVIL'];

/** Departments of a teacher as an array. Also understands old accounts that
 *  only had a single free-text `department` string (e.g. "CSE"). */
function teacherDepartments(t) {
  if (Array.isArray(t?.departments)) return t.departments;
  return String(t?.department || '')
    .split(/[,/;|]/)
    .map((d) => d.trim().toUpperCase())
    .filter((d) => DEPARTMENTS.includes(d));
}

/** Keeps only valid, de-duplicated departments from user input. */
function cleanDepartments(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const d of arr) {
    const v = String(d || '').trim().toUpperCase();
    if (DEPARTMENTS.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Is this student one of the teacher's students? Students created before the
 *  teacherIds field existed fall back to "created by this teacher". */
function studentVisibleTo(student, teacherId) {
  if (Array.isArray(student.teacherIds)) return student.teacherIds.includes(teacherId);
  return student.createdBy === teacherId;
}

module.exports = { id, tempPassword, readableId, uniqueLoginId, DEPARTMENTS, teacherDepartments, cleanDepartments, studentVisibleTo };
