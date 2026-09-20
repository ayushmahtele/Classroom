const jwt = require('jsonwebtoken');
const db = require('../db');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // An account the admin has removed can't keep using its old login token.
    if (!db.users.findById(payload.id)) return res.status(401).json({ error: 'This account no longer exists' });
    req.user = payload; // { id, role, name, loginId }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole };
