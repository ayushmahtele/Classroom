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

/** Auto-incrementing roll number (1, 2, 3 ...). Shared by admin and teacher
 *  student creation so numbers never collide. Handled synchronously so two
 *  simultaneous requests can never get the same number. */
let rollCounter = null;
function nextRollNumber(users) {
  if (rollCounter === null) {
    rollCounter = 0;
    for (const u of users) {
      if (u.role === 'student' && /^\d+$/.test(String(u.rollNumber || ''))) {
        rollCounter = Math.max(rollCounter, Number(u.rollNumber));
      }
    }
  }
  rollCounter += 1;
  return String(rollCounter);
}

/** Is this student one of the teacher's students? Students created before the
 *  teacherIds field existed fall back to "created by this teacher". */
function studentVisibleTo(student, teacherId) {
  if (Array.isArray(student.teacherIds)) return student.teacherIds.includes(teacherId);
  return student.createdBy === teacherId;
}

module.exports = { id, tempPassword, readableId, DEPARTMENTS, teacherDepartments, cleanDepartments, nextRollNumber, studentVisibleTo };
