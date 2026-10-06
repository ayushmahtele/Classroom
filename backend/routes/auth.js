const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired, blockedReason } = require('../middleware/auth');
const { sendMail, isMailConfigured, resetCodeEmail, maskEmail } = require('../utils/mailer');

const router = express.Router();

const ROLES = ['student', 'teacher', 'admin'];
const looksLikeEmail = (v) => String(v || '').includes('@');

/** Finds the account of `role` by email, by its ID (login ID), or by either.
 *  The "admin" role covers both college admins and the global admin. */
function findAccount(role, identifier, by = 'any') {
  const v = String(identifier || '').trim().toLowerCase();
  if (!v) return null;
  return db.users.findOne((u) => {
    if (role && u.role !== role) return false;
    const emailHit = u.email?.toLowerCase() === v;
    const idHit = u.loginId?.toLowerCase() === v;
    if (by === 'email') return emailHit;
    if (by === 'id') return idHit;
    return emailHit || idHit;
  });
}

const ROLE_NAME = { student: 'Student', teacher: 'Teacher', admin: 'Admin' };

/** "No student account exists that is associated with you@mail.com / Student ID STU1234" */
function noAccountMessage(role, identifier, by = 'any') {
  const v = String(identifier || '').trim();
  const asEmail = by === 'email' || (by === 'any' && looksLikeEmail(v));
  return `No ${role} account exists that is associated with ${asEmail ? v : `${ROLE_NAME[role]} ID ${v}`}`;
}

// Anyone (student, teacher, college admin, global admin) logs in here with
// either the email attached to their account OR their Student / Teacher /
// Admin ID (STU2048 / TCH1024 / ADM1234 / ADMIN001) + password. The role tab
// they picked is sent as `role`: if no account at all matches, the error names
// that role. If the account exists but is of another role, the login page
// shows "That account is registered as student, not teacher. Choose the right tab."
router.post('/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  const role = ROLES.includes(req.body?.role) ? req.body.role : null;
  if (!loginId || !password) {
    return res.status(400).json({ error: 'ID or email and password are required' });
  }

  const user = findAccount(null, loginId);
  if (!user) {
    return res.status(401).json({ error: role ? noAccountMessage(role, loginId) : 'Account not found' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  // Suspended account, or its whole college suspended by the platform admin
  const blocked = blockedReason(user);
  if (blocked) return res.status(403).json({ error: blocked });

  const payload = {
    id: user.id,
    role: user.role,
    name: user.name,
    loginId: user.loginId,
    email: user.email,
    collegeId: user.collegeId || null // null = global (platform) admin
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h'
  });

  res.json({
    token,
    user: payload,
    mustChangePassword: !!user.mustChangePassword
  });
});

// ---- Sign in with Google -------------------------------------------------
// The login page shows a "Sign in with Google" button when GOOGLE_CLIENT_ID is
// set. Google gives the browser a signed ID token; we verify it here and sign
// in the account whose email matches the Google (Gmail) address.
// (Statuses used here are never 401, so the login page doesn't reload.)
let googleClient = null;
function getGoogleClient() {
  if (!googleClient) {
    const { OAuth2Client } = require('google-auth-library');
    googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return googleClient;
}

router.get('/google-config', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

router.post('/google', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not set up on this server.' });
  const role = ROLES.includes(req.body?.role) ? req.body.role : null;
  const credential = req.body?.credential;
  if (!credential) return res.status(400).json({ error: 'Google sign-in failed. Please try again.' });

  let info;
  try {
    const ticket = await getGoogleClient().verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    info = ticket.getPayload();
  } catch (err) {
    console.error('Google token check failed:', err.message);
    return res.status(400).json({ error: 'Google sign-in failed. Please try again.' });
  }
  const email = String(info?.email || '').trim();
  if (!email || info.email_verified === false) {
    return res.status(400).json({ error: 'Your Google account email is not verified.' });
  }

  const user = findAccount(null, email, 'email');
  if (!user) {
    return res.status(404).json({ error: role ? noAccountMessage(role, email, 'email') : `No account exists that is associated with ${email}` });
  }
  if (role && user.role !== role) {
    return res.status(403).json({ error: `That account is registered as ${user.role}, not ${role}. Choose the right tab.` });
  }
  const blocked = blockedReason(user);
  if (blocked) return res.status(403).json({ error: blocked });

  const payload = {
    id: user.id,
    role: user.role,
    name: user.name,
    loginId: user.loginId,
    email: user.email,
    collegeId: user.collegeId || null
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h'
  });
  res.json({ token, user: payload, mustChangePassword: !!user.mustChangePassword });
});

router.get('/me', authRequired, (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { passwordHash, ...safe } = user;
  const college = user.collegeId ? db.colleges.findById(user.collegeId) : null;
  res.json({ ...safe, college: college ? { id: college.id, name: college.name, shortName: college.shortName } : null });
});

router.post('/change-password', authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.mustChangePassword) {
    const ok = currentPassword && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' }); // 400 (not 401) so the client doesn't treat it as an expired session
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.users.update(user.id, { passwordHash, mustChangePassword: false, resetRequested: null });
  res.json({ ok: true });
});

// ---- Forgot password ------------------------------------------------------
// There is no email service, so "forgot password" raises a reset request:
// the student's teacher / the admin sees it and issues a new temporary password.
// Teachers' requests go to their college admin (and the global admin); college
// admins' requests go to the global admin. (The global admin can't be reset this way.)
const isGlobalAdmin = (u) => u.role === 'admin' && !u.collegeId;
async function flagResetRequest(user) {
  if (!user || isGlobalAdmin(user)) return false;
  await db.users.update(user.id, { resetRequested: new Date().toISOString() });
  return true;
}

// Logged-in user who has forgotten their current password
router.post('/request-reset', authRequired, async (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isGlobalAdmin(user)) return res.status(400).json({ error: 'The platform admin password cannot be reset this way.' });
  await flagResetRequest(user);
  res.json({ ok: true });
});

// Locked-out user on the login page. Always answers the same way so it can't
// be used to find out which IDs exist.
router.post('/forgot-password', async (req, res) => {
  const idLower = String(req.body?.loginId || '').trim().toLowerCase();
  if (idLower) {
    const user = db.users.findOne((u) => u.email?.toLowerCase() === idLower || u.loginId?.toLowerCase() === idLower);
    await flagResetRequest(user);
  }
  res.json({ ok: true, message: 'If that account exists, a password reset request has been sent to your teacher/admin.' });
});

// ---- Forgot password with a 6-digit email code ---------------------------
// Step 1  POST /forgot-password/send-code    { role, by: 'id'|'email', identifier }
//         -> emails a 6-digit code, answers with the masked email it went to
// Step 2  POST /forgot-password/verify-code  { role, by, identifier, code }
//         -> answers with a one-time resetToken
// Step 3  POST /forgot-password/reset        { role, by, identifier, resetToken, newPassword }
const CODE_MINUTES = 10;          // code is valid for 10 minutes
const MAX_ATTEMPTS = 5;           // wrong guesses before the code is thrown away
const RESEND_SECONDS = 60;        // wait between two codes for the same account
const MAX_SENDS_PER_HOUR = 5;     // codes per account per hour
const RESET_TOKEN_MINUTES = 15;   // time to choose the new password after verifying

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (userId, code) => sha256(`${userId}:${code}:${process.env.JWT_SECRET}`);
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Small per-IP limiter so the endpoint can't be used to spam inboxes.
const ipHits = new Map();
function ipLimited(req, max = 30, windowMs = 60 * 60 * 1000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || 'unknown';
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > max;
}

/** Validates { role, by, identifier } and finds the account (or answers the error). */
function resolveResetAccount(req, res) {
  const { role, identifier } = req.body || {};
  const by = req.body?.by === 'email' ? 'email' : 'id';
  if (!ROLES.includes(role)) { res.status(400).json({ error: 'Choose Student, Teacher or Admin first' }); return null; }
  if (!String(identifier || '').trim()) {
    res.status(400).json({ error: by === 'email' ? 'Enter your email' : `Enter your ${ROLE_NAME[role]} ID` });
    return null;
  }
  const user = findAccount(role, identifier, by);
  if (!user) { res.status(404).json({ error: noAccountMessage(role, identifier, by) }); return null; }
  return { user, by };
}

// Emails a fresh 6-digit code to the account. Answers { status, body }.
// Used by the sign-in page and by "Forgot your current password?" inside
// the dashboard.
async function issueResetCode(user) {
  const blocked = blockedReason(user);
  if (blocked) return { status: 403, body: { error: blocked } };
  if (!user.email) return { status: 400, body: { error: 'This account has no email attached. Ask your teacher/admin to reset your password.' } };
  if (!isMailConfigured()) return { status: 503, body: { error: 'Password reset by email is not set up on this server yet. Ask your teacher/admin to reset your password.' } };

  const now = Date.now();
  const prev = await db.passwordResets.get(user.id);
  if (prev?.lastSentAt && now - prev.lastSentAt < RESEND_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_SECONDS * 1000 - (now - prev.lastSentAt)) / 1000);
    return { status: 429, body: { error: `Please wait ${wait}s before asking for a new code.`, retryAfter: wait } };
  }
  const sends = (prev?.sends || []).filter((t) => now - t < 60 * 60 * 1000);
  if (sends.length >= MAX_SENDS_PER_HOUR) {
    return { status: 429, body: { error: 'Too many codes asked for this account. Try again in an hour.' } };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = now + CODE_MINUTES * 60 * 1000;

  // Save the code BEFORE emailing it, so a code that arrives is always valid
  // even if the email service answers slowly.
  await db.passwordResets.set(user.id, {
    codeHash: codeHash(user.id, code),
    expiresAt,
    attempts: 0,
    lastSentAt: now,
    sends: [...sends, now],
    tokenHash: null,
    tokenExpiresAt: null,
    expireAt: new Date(now + 2 * 60 * 60 * 1000) // MongoDB cleans the record up after 2h
  });

  // Send the email. If it finishes within a few seconds we report the real
  // result; if the email service is just slow to confirm (Apps Script often
  // is), we move the user on and let it finish in the background.
  const mail = resetCodeEmail({ name: user.name, code, role: user.role, minutes: CODE_MINUTES });
  const sending = sendMail({ to: user.email, ...mail }).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, err })
  );
  const QUICK_WAIT_MS = 4000;
  const result = await Promise.race([sending, new Promise((r) => setTimeout(() => r(null), QUICK_WAIT_MS))]);

  if (result && !result.ok) {
    console.error('Reset code email failed:', result.err.message);
    // undo, so the user can try again straight away
    await db.passwordResets.update(user.id, { codeHash: null, lastSentAt: prev?.lastSentAt || 0, sends });
    return { status: 502, body: { error: 'Could not send the email right now. Please try again in a minute.' } };
  }
  if (!result) {
    sending.then((r) => { if (!r.ok) console.error('Reset code email failed (background):', r.err.message); });
  }
  return { status: 200, body: { ok: true, maskedEmail: maskEmail(user.email), expiresInMinutes: CODE_MINUTES, resendAfter: RESEND_SECONDS } };
}

// Checks a 6-digit code and uses it up. Answers { ok } or { status, error }.
async function checkResetCode(user, rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length !== 6) return { status: 400, error: 'Enter the 6-digit code from the email' };
  const rec = await db.passwordResets.get(user.id);
  if (!rec?.codeHash) return { status: 400, error: 'No active code for this account. Send a new code.' };
  if (Date.now() > rec.expiresAt) {
    await db.passwordResets.update(user.id, { codeHash: null });
    return { status: 400, error: 'This code has expired. Send a new code.' };
  }
  if (!sameHash(rec.codeHash, codeHash(user.id, code))) {
    const attempts = (rec.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.passwordResets.update(user.id, { codeHash: null, attempts });
      return { status: 400, error: 'Too many wrong tries. Send a new code.' };
    }
    await db.passwordResets.update(user.id, { attempts });
    const left = MAX_ATTEMPTS - attempts;
    return { status: 400, error: `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` };
  }
  await db.passwordResets.update(user.id, { codeHash: null });
  return { ok: true };
}

router.post('/forgot-password/send-code', async (req, res) => {
  if (ipLimited(req)) return res.status(429).json({ error: 'Too many requests. Try again in a while.' });
  const found = resolveResetAccount(req, res);
  if (!found) return;
  const r = await issueResetCode(found.user);
  res.status(r.status).json(r.body);
});

router.post('/forgot-password/verify-code', async (req, res) => {
  if (ipLimited(req, 60)) return res.status(429).json({ error: 'Too many requests. Try again in a while.' });
  const found = resolveResetAccount(req, res);
  if (!found) return;
  const { user } = found;
  const check = await checkResetCode(user, req.body?.code);
  if (!check.ok) return res.status(check.status).json({ error: check.error });

  // Correct: the code is used up and swapped for a one-time reset token.
  const resetToken = crypto.randomBytes(32).toString('hex');
  await db.passwordResets.update(user.id, {
    tokenHash: sha256(resetToken),
    tokenExpiresAt: Date.now() + RESET_TOKEN_MINUTES * 60 * 1000
  });
  res.json({ ok: true, resetToken });
});

// ---- "Forgot your current password?" inside the dashboard ------------------
// For a signed-in student / teacher / college admin / global admin who doesn't
// remember their current password: a 6-digit code goes to their own email,
// then they set a new password with that code (no current password needed).
router.post('/me/send-reset-code', authRequired, async (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const r = await issueResetCode(user);
  res.status(r.status).json(r.body);
});

router.post('/me/reset-with-code', authRequired, async (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { code, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const check = await checkResetCode(user, code);
  if (!check.ok) return res.status(check.status).json({ error: check.error });
  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await db.users.update(user.id, { passwordHash, mustChangePassword: false, resetRequested: null });
  await db.passwordResets.remove(user.id);
  res.json({ ok: true });
});

router.post('/forgot-password/reset', async (req, res) => {
  const found = resolveResetAccount(req, res);
  if (!found) return;
  const { user } = found;
  const { resetToken, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const rec = await db.passwordResets.get(user.id);
  if (!rec?.tokenHash || !resetToken || !sameHash(rec.tokenHash, sha256(resetToken))) {
    return res.status(400).json({ error: 'This reset session is no longer valid. Start again.' });
  }
  if (Date.now() > rec.tokenExpiresAt) {
    await db.passwordResets.remove(user.id);
    return res.status(400).json({ error: 'Took too long to set the new password. Start again.' });
  }

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await db.users.update(user.id, { passwordHash, mustChangePassword: false, resetRequested: null });
  await db.passwordResets.remove(user.id);
  res.json({ ok: true, loginId: user.loginId });
});

module.exports = router;
