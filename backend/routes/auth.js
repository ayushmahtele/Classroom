const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Anyone (admin, teacher, student) logs in here with either their
// email OR their assigned login ID (ADMIN001 / TCH1024 / STU2048) + password
router.post('/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) {
    return res.status(400).json({ error: 'loginId and password are required' });
  }

  const idLower = String(loginId).trim().toLowerCase();
  const user = db.users.findOne(
    (u) =>
      u.email?.toLowerCase() === idLower ||
      u.loginId?.toLowerCase() === idLower
  );

  if (!user) return res.status(401).json({ error: 'Account not found' });
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Contact your admin.' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  const payload = {
    id: user.id,
    role: user.role,
    name: user.name,
    loginId: user.loginId,
    email: user.email
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

router.get('/me', authRequired, (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { passwordHash, ...safe } = user;
  res.json(safe);
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
// Teachers' requests go to the admin. (Admin accounts can't be reset this way.)
async function flagResetRequest(user) {
  if (!user || user.role === 'admin') return false;
  await db.users.update(user.id, { resetRequested: new Date().toISOString() });
  return true;
}

// Logged-in user who has forgotten their current password
router.post('/request-reset', authRequired, async (req, res) => {
  const user = db.users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Admin passwords cannot be reset this way.' });
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

module.exports = router;
