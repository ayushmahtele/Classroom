# Proctored Quiz Web — multi-user, internet-accessible version

This replaces your original Java desktop app (which only worked because
every user's browser shared the same `localStorage` on one PC) with a
real client-server web app: one shared backend that any browser, on any
computer, anywhere, can log into.

```
Admin (anywhere) ──┐
Teacher (anywhere) ─┼──► https://yourapp.com ──► Node/Express API ──► db.json (or MongoDB)
Student (anywhere) ─┘                                   │
                                                    uploads/evidence (proctoring snapshots)
```

## What's preserved from your original project, and what changed

| Your Java/HTML project | This web version |
|---|---|
| Admin / Teacher / Student roles | Same 3 roles, now with real server-side permission checks |
| `data.json` in `localStorage` (per-browser) | Shared backend storage (`backend/data/db.json`), swappable for MongoDB |
| Java `VideoCapture(0)` + Haar cascades (desktop only, only saw the *server's* camera) | Browser `getUserMedia()` + face-api.js — runs on **each student's own device** |
| Face / multiple-face / eye detection (Haar cascades) | Face-api.js (TinyFaceDetector + 68-point landmarks) for face count, eye-aspect-ratio (closed eyes), and head-turn ("looking away") |
| — (not present before) | Phone / suspicious-object detection via TensorFlow.js COCO-SSD |
| — | Tab-switch, fullscreen-exit, copy/paste, right-click monitoring |
| Evidence screenshots saved locally | Evidence JPEGs uploaded to the server only when an event fires, stored under `backend/uploads/evidence/` |
| Console/GUI teacher menu | Real teacher web dashboard: classes, students, quizzes, results, attendance, proctoring reports, **live monitor** (Socket.IO) |
| No admin invite flow | Admin creates a teacher from anywhere with just their name + email → gets a login ID + temp password to hand over |

## Multiple colleges on one deployment

Several colleges can use the same site at the same time without their data
mixing:

```
Global admin (bootstrap ADMIN001)
 ├── College A (e.g. JIIT) ── college admin ── teachers ── students (JIIT1, JIIT2 …)
 └── College B (e.g. AU)   ── college admin ── teachers ── students (AU1, AU2 …)
```

- **Global admin** — the bootstrap admin. Adds colleges (name + unique short
  name + one college admin), can suspend/remove a whole college, and sees and
  manages every college's teachers, students and data.
- **College admin** — signs in from the same *Admin* tab. Sees only their own
  college. Everything they add goes into their college automatically. Their
  deletions always go to the recycle bin; they cannot restore what the global
  admin deleted, but the global admin can restore anything.
- **Teachers / students** belong to one college. Teachers can only see and pick
  students of their own college. Roll numbers are generated per college
  (short name + running number).
- Suspending a college locks out its admin, teachers and students immediately.
  Removing a college moves the college and all its data to the recycle bin.

**Upgrading an existing deployment:** on the first start, every existing
teacher/student is moved into one college named by `LEGACY_COLLEGE_NAME`
(default "My College", short name `MC`), and old roll numbers 1, 2, 3 become
MC1, MC2, MC3. Then, as the global admin: *Colleges → Edit* to rename it (e.g.
to JIIT — roll numbers follow) and *Create admin* to give it a college admin.

## Project layout

```
ProctoredQuizWeb/
├── backend/            Node.js + Express API, JWT auth, Socket.IO live dashboard
│   ├── server.js
│   ├── db.js            file-based JSON "database" (swap for MongoDB later, see below)
│   ├── routes/           auth.js, admin.js, teacher.js, student.js, proctor.js
│   ├── utils/college.js  colleges, per-college roll numbers, upgrade migration
│   ├── middleware/auth.js
│   ├── data/db.json      created automatically on first run
│   └── uploads/evidence/ proctoring evidence snapshots
└── frontend/            Plain HTML/CSS/JS (no build step needed)
    ├── index.html        login (role tabs: student/teacher/admin)
    ├── admin.html / js/admin.js
    ├── teacher.html / js/teacher.js
    ├── student.html / js/student.js
    ├── quiz.html / js/quiz.js     the proctored quiz-taking screen
    └── js/proctor.js               the camera-based CV engine
```

The Express server also serves the `frontend/` folder as static files, so
**one deployment = the whole app** (no separate frontend host needed,
though you can split them if you prefer — see `frontend/js/api.js`).

## Running it locally

```bash
cd backend
cp .env.example .env      # then edit JWT_SECRET, admin email/password
npm install
npm start
```

Open `http://localhost:5000`. The first time it starts, it prints your
bootstrap admin's login ID/email/password in the terminal — use those to
log in as Admin, then use **Admin → Teachers → + Add Teacher** to create
your first teacher account (this generates a Teacher ID + temp password
you hand to them), and the teacher then adds students the same way.

Because it's a real server, two different computers on the same Wi-Fi
(or over the internet once deployed) can both reach it — that's what
makes teacher/student "from anywhere" actually work.

## Deploying for free / cheap so it's on the public internet

1. **Backend + frontend together (simplest):** push this folder to GitHub
   and deploy the `backend/` folder as a Web Service on **Render** or
   **Railway** (both have free/cheap tiers). Set the environment
   variables from `.env.example` in their dashboard. Because
   `server.js` serves `frontend/` too, this one service is your entire
   public site, e.g. `https://your-quiz.onrender.com`.
2. **MongoDB Atlas** (optional, recommended once you have many users) —
   see "Upgrading storage" below; the free M0 tier is enough to start.
3. **Evidence storage** — the free tiers of Render/Railway use
   *ephemeral* disks, meaning `uploads/evidence/` can be wiped on
   redeploy/restart. For a real deployment, swap the `multer.diskStorage`
   in `backend/routes/proctor.js` for a free-tier object storage
   (Cloudinary, Supabase Storage, or Cloudflare R2) — the rest of the
   app doesn't need to change, only where that one file is written.

Nothing in the proctoring pipeline calls a paid AI API — face-api.js and
COCO-SSD are free, open-source models that run in the student's browser.

## Upgrading storage from JSON file → MongoDB

Every route only ever talks to `db.<collection>.find/findOne/insert/update/remove`
(see `backend/db.js`). To move to MongoDB Atlas later:
1. `npm install mongoose`
2. Define schemas matching the shapes already used (User, Class, Quiz, Attempt, ProctorEvent, Attendance)
3. Reimplement the same five methods per collection using Mongoose, keeping the same function names/signatures
4. No route file changes needed

## Security notes before going live

- Set a long random `JWT_SECRET` in production, never the example value.
- Put this behind HTTPS (Render/Railway give you this automatically).
- Proctoring evidence images and the live monitor are restricted to the quiz's
  own teacher, that college's admin, and the global admin.
- Consider rate-limiting `/api/auth/login` against brute-forcing.

## Known browser limitations (same as any web-based proctoring system)

A public website — this one included — cannot see other applications on
a student's computer, guarantee DevTools is closed, or block every
possible second device used to cheat. What it *can* do reliably:
on-device face/eye/object detection, tab-switch and fullscreen-exit
detection, and copy/paste/right-click blocking — all implemented here.
For stricter lockdown you'd add a dedicated secure-browser client on top
of this same backend; the API already supports that (it doesn't care
what UI reports the proctoring events).


## Sign in with email or ID, and forgot password by email code

- Students, teachers, college admins and the global admin can sign in with
  either their **Student / Teacher / Admin ID** (such as `STU2048`, `TCH1024`, `ADM1024`,
  `ADMIN001`) or the **email attached to their account**. Only accounts of the
  selected tab can sign in from it. If nothing matches, the page shows e.g.
  *"No teacher account exists that is associated with you@mail.com"*; if the
  account belongs to another tab it shows *"That account is registered as
  student, not teacher. Choose the right tab."*
- **Forgot password?** (just below the Student / Teacher / Admin tabs): the user
  picks their Student/Teacher/Admin ID or Email, a 6-digit code is emailed to the account's registered
  address (shown masked, e.g. `ay*********e@g****.com`), they enter the code and
  choose a new password. Codes expire after 10 minutes, allow 5 wrong tries, can
  be resent after 60 s, and are stored hashed in the `passwordResets` collection.
- Configure email in `backend/.env` (see `.env.example`): `BREVO_API_KEY`
  (HTTPS — recommended on Render) or `SMTP_*`, plus `MAIL_FROM`. If neither is
  set, users can still use "Ask your teacher/admin for a reset".
