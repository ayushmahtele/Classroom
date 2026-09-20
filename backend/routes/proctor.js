const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { authRequired, requireRole } = require('../middleware/auth');
const { id } = require('../utils/helpers');

const router = express.Router();

const EVIDENCE_DIR = path.join(__dirname, '..', 'uploads', 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// Screenshots are kept in memory just long enough to be saved into MongoDB,
// so they survive restarts/redeploys on any host (no local disk needed).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

const VALID_TYPES = [
  'NO_FACE',
  'MULTIPLE_FACES',
  'EYES_CLOSED',
  'LOOKING_AWAY',
  'PHONE_DETECTED',
  'OBJECT_DETECTED',
  'TAB_SWITCH',
  'FULLSCREEN_EXIT',
  'CAMERA_DISCONNECTED',
  'COPY_PASTE',
  'RIGHT_CLICK'
];

// Student's browser posts an event here the moment its on-device CV
// (face-api.js / coco-ssd) or a browser API (visibilitychange,
// fullscreenchange, copy/paste) flags something suspicious.
router.post(
  '/events',
  authRequired,
  requireRole('student'),
  upload.single('evidence'),
  async (req, res) => {
    const { attemptId, quizId, type, confidence, meta } = req.body || {};
    if (!attemptId || !quizId || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'attemptId, quizId and a valid type are required' });
    }
    const attempt = db.attempts.findById(attemptId);
    if (!attempt || attempt.studentId !== req.user.id) {
      return res.status(404).json({ error: 'Attempt not found' });
    }

    // Save the screenshot (if any) permanently in MongoDB. If saving ever
    // fails the alert itself is still recorded, just without the image.
    let evidenceFile = null;
    if (req.file) {
      const safeType = String(type).replace(/[^A-Z0-9_]/gi, '');
      const filename = `${Date.now()}_${safeType}_${id().slice(0, 8)}.jpg`;
      try {
        await db.saveEvidence(filename, req.file.buffer, req.file.mimetype || 'image/jpeg');
        evidenceFile = filename;
      } catch (e) {
        console.warn('Could not save evidence image:', e.message);
      }
    }

    const event = {
      id: id(),
      attemptId,
      quizId,
      studentId: req.user.id,
      type,
      confidence: confidence ? Number(confidence) : null,
      meta: meta ? JSON.parse(meta) : null,
      evidenceFile,
      timestamp: new Date().toISOString()
    };
    await db.proctorEvents.insert(event);
    await db.attempts.update(attemptId, { alertCount: (attempt.alertCount || 0) + 1 });

    // push to any teacher currently watching this quiz's live dashboard
    const io = req.app.get('io');
    if (io) {
      io.to(`quiz:${quizId}`).emit('proctor-event', {
        ...event,
        studentName: req.user.name
      });
    }

    res.status(201).json({ ok: true, id: event.id });
  }
);

// Teacher/admin views the evidence image for an event
router.get('/evidence/:filename', authRequired, requireRole('teacher', 'admin'), async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    const found = await db.getEvidence(filename);
    if (found) {
      res.set('Content-Type', found.contentType);
      return res.send(found.data);
    }
  } catch (e) {
    console.warn('Evidence lookup failed:', e.message);
  }
  // Older screenshots saved to disk before this change
  const file = path.join(EVIDENCE_DIR, filename);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).json({ error: 'Not found' });
});

module.exports = router;
