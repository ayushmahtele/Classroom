const jwt = require('jsonwebtoken');
const db = require('../db');

/** Why this account can't be used right now (or null if it can). */
function blockedReason(user) {
  if (!user) return 'This account no longer exists';
  if (user.status === 'suspended') return 'This account has been suspended. Contact your admin.';
  if (user.collegeId) {
    const college = db.colleges.findById(user.collegeId);
    if (!college) return 'This account no longer exists';
    if (college.status === 'suspended') return 'Your college has been suspended on this platform. Contact the platform admin.';
  }
  return null;
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A removed or suspended account (or one whose college is removed/suspended)
  // can't keep using an old login token.
  const user = db.users.findById(payload.id);
  const reason = blockedReason(user);
  if (reason) return res.status(401).json({ error: reason });
  req.user = { ...payload, collegeId: user.collegeId || null }; // { id, role, name, loginId, collegeId }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

/** For admin routes: sets req.isGlobal (platform/bootstrap admin, sees every
 *  college) or req.collegeId (college admin, sees only their own college). */
function adminScope(req, res, next) {
  req.isGlobal = !req.user.collegeId;
  req.collegeId = req.user.collegeId || null;
  next();
}

function requireGlobalAdmin(req, res, next) {
  if (!req.isGlobal) return res.status(403).json({ error: 'Only the platform (global) admin can do that' });
  next();
}

module.exports = { authRequired, requireRole, adminScope, requireGlobalAdmin, blockedReason };
