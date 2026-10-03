const dns = require('node:dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const db = require('./db');
const { id } = require('./utils/helpers');
const { migrateToColleges } = require('./utils/college');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const studentRoutes = require('./routes/student');
const proctorRoutes = require('./routes/proctor');

const app = express();
const server = http.createServer(app);

const corsOrigin = process.env.CORS_ORIGIN === '*' ? '*' : (process.env.CORS_ORIGIN || '*').split(',');
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));

// ---- Bootstrap the very first admin account (idempotent) -----------------
// This is the GLOBAL (platform) admin: an admin account with no collegeId.
// College admins are created by the global admin from Admin -> Colleges.
async function bootstrapAdmin() {
  const already = db.users.findOne((u) => u.role === 'admin' && !u.collegeId);
  if (already) return;
  const passwordHash = await bcrypt.hash(process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe@123', 10);
  await db.users.insert({
    id: id(),
    role: 'admin',
    name: 'Platform Admin',
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@yourcollege.edu',
    loginId: process.env.BOOTSTRAP_ADMIN_ID || 'ADMIN001',
    passwordHash,
    mustChangePassword: true,
    status: 'active',
    createdAt: new Date().toISOString()
  });
  console.log('----------------------------------------------------------');
  console.log('First-run: created bootstrap admin account');
  console.log('  Login ID / Email :', process.env.BOOTSTRAP_ADMIN_ID || 'ADMIN001', '/', process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@yourcollege.edu');
  console.log('  Password         :', process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe@123');
  console.log('  (you will be asked to change this password on first login)');
  console.log('----------------------------------------------------------');
}

// ---- API routes -----------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/proctor', proctorRoutes);

// ---- Serve the frontend (so the whole app is one deployable unit) --------
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// ---- Socket.IO: live proctoring dashboard --------------------------------
const io = new Server(server, { cors: { origin: corsOrigin } });
app.set('io', io);

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No auth token'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    const u = db.users.findById(socket.user.id);
    if (!u) return next(new Error('Account not found'));
    socket.user.collegeId = u.collegeId || null;
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  // Teachers/admins subscribe to a quiz's live room to watch alerts stream in
  socket.on('watch-quiz', (quizId) => {
    // only the quiz's own teacher, its college admin, or the global admin
    if (['teacher', 'admin'].includes(socket.user.role) && proctorRoutes.canViewQuiz(socket.user, db.quizzes.findById(quizId))) {
      socket.join(`quiz:${quizId}`);
    }
  });
  socket.on('unwatch-quiz', (quizId) => {
    socket.leave(`quiz:${quizId}`);
  });
});

const PORT = process.env.PORT || 5000;

// ---- Connect to MongoDB, then bootstrap admin, then start listening ------
async function start() {
  await db.connect();
  await bootstrapAdmin();
  await migrateToColleges(); // one-time: puts pre-existing teachers/students into a college
  server.listen(PORT, () => {
    console.log(`Proctored Quiz API + frontend running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
