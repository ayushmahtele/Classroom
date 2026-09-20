/**
 * db.js — MongoDB-backed version
 * ------------------------------------------------------------------
 * Drop-in replacement for the original file-based db.json storage.
 * Exposes the exact same collection API used everywhere else in the
 * app (all / find / findOne / findById / insert / update / remove),
 * so NONE of the route files (auth.js, admin.js, teacher.js,
 * student.js, proctor.js) need to change.
 *
 * How it works:
 *  - On startup, call db.connect() once (done in server.js) to open
 *    a MongoDB connection and load every collection into an
 *    in-memory cache.
 *  - Reads (all/find/findOne/findById) are served instantly from
 *    that cache, exactly like the old synchronous file reads — so
 *    existing route code that calls them without `await` keeps
 *    working unchanged.
 *  - Writes (insert/update/remove) write through to MongoDB AND
 *    update the cache, so subsequent reads stay correct.
 *
 * Requires MONGODB_URI in your .env (see .env.example).
 * ------------------------------------------------------------------
 */
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const EVIDENCE_DIR = path.join(__dirname, 'uploads', 'evidence');

const COLLECTIONS = ['users', 'classes', 'quizzes', 'attempts', 'proctorEvents', 'attendance'];

const cache = {
  users: [],
  classes: [],
  quizzes: [],
  attempts: [],
  proctorEvents: [],
  attendance: []
};

let client = null;
let mongoDb = null;

// Mongo adds its own `_id` field on insert. Strip it so documents keep
// looking exactly like they did in the old JSON-file version, which
// only ever used our own `id` field.
function stripMongoId(doc) {
  if (doc && Object.prototype.hasOwnProperty.call(doc, '_id')) {
    const { _id, ...rest } = doc;
    return rest;
  }
  return doc;
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Add it to backend/.env (see .env.example).'
    );
  }

  client = new MongoClient(uri);
  await client.connect();

  // If your connection string includes a database name in the path
  // (e.g. .../proctored_quiz?...), client.db() with no argument uses
  // that automatically. MONGODB_DB_NAME can override it if needed.
  mongoDb = client.db(process.env.MONGODB_DB_NAME || undefined);

  for (const name of COLLECTIONS) {
    const docs = await mongoDb.collection(name).find({}).toArray();
    cache[name] = docs.map(stripMongoId);
  }

  // Evidence screenshots live in their own collection and are NOT loaded into
  // the in-memory cache (they are read on demand only).
  await mongoDb.collection('evidence').createIndex({ filename: 1 }, { unique: true });
  await mongoDb.collection('evidenceTrash').createIndex({ filename: 1 }, { unique: true });
  await mongoDb.collection('trash').createIndex({ deletedAt: -1 });
  await mongoDb.collection('trash').createIndex({ teacherId: 1 });

  console.log('Connected to MongoDB Atlas and loaded data into memory cache.');
}

// ---- Evidence images (permanent storage in MongoDB) ---------------------
async function saveEvidence(filename, buffer, contentType = 'image/jpeg') {
  await mongoDb.collection('evidence').insertOne({
    filename,
    contentType,
    data: buffer,
    createdAt: new Date().toISOString()
  });
}

async function getEvidence(filename) {
  const doc = await mongoDb.collection('evidence').findOne({ filename });
  if (!doc) return null;
  const raw = doc.data && doc.data.buffer ? doc.data.buffer : doc.data;
  return { contentType: doc.contentType || 'image/jpeg', data: Buffer.from(raw) };
}

// Move an evidence image between the live and the recycle-bin collections.
// (Older screenshots that were saved on the server disk are handled too.)
async function moveEvidence(filename, from, to, extra = {}) {
  const src = mongoDb.collection(from);
  let doc = await src.findOne({ filename });
  if (!doc && from === 'evidence') {
    const file = path.join(EVIDENCE_DIR, path.basename(filename));
    if (fs.existsSync(file)) {
      doc = { filename, contentType: 'image/jpeg', data: fs.readFileSync(file), createdAt: new Date().toISOString(), _disk: file };
    }
  }
  if (!doc) return false;
  const { _id, _disk, ...rest } = doc;
  await mongoDb.collection(to).updateOne({ filename }, { $set: { ...rest, ...extra } }, { upsert: true });
  if (_disk) { try { fs.unlinkSync(_disk); } catch (_) { /* ignore */ } }
  else await src.deleteOne({ filename });
  return true;
}
const trashEvidence = (filename, trashId) => moveEvidence(filename, 'evidence', 'evidenceTrash', { trashId });
const restoreEvidence = (filename) => moveEvidence(filename, 'evidenceTrash', 'evidence');

// Permanently erase live evidence images.
async function deleteEvidence(filenames) {
  let n = 0;
  for (const f of filenames) {
    const r = await mongoDb.collection('evidence').deleteOne({ filename: f });
    n += r.deletedCount;
    const file = path.join(EVIDENCE_DIR, path.basename(f));
    if (fs.existsSync(file)) { try { fs.unlinkSync(file); n++; } catch (_) { /* ignore */ } }
  }
  return n;
}

// Recycle bin records. Not held in the in-memory cache (they can be large),
// so these read/write MongoDB directly.
const trash = {
  async insert(rec) {
    await mongoDb.collection('trash').insertOne({ ...rec });
    return rec;
  },
  // `query` is a plain Mongo filter; the heavy `payload` is left out of lists.
  async list(query = {}) {
    const rows = await mongoDb.collection('trash').find(query, { projection: { payload: 0 } }).sort({ deletedAt: -1 }).toArray();
    return rows.map(stripMongoId);
  },
  async get(id) {
    return stripMongoId(await mongoDb.collection('trash').findOne({ id }));
  },
  async remove(id) {
    await mongoDb.collection('trash').deleteOne({ id });
  }
};

function makeCollection(name) {
  return {
    all() {
      return cache[name];
    },
    find(predicate) {
      return cache[name].filter(predicate);
    },
    findOne(predicate) {
      return cache[name].find(predicate) || null;
    },
    findById(id) {
      return cache[name].find((x) => x.id === id) || null;
    },
    async insert(doc) {
      await mongoDb.collection(name).insertOne({ ...doc });
      cache[name].push(doc);
      return doc;
    },
    async update(id, patch) {
      await mongoDb.collection(name).updateOne({ id }, { $set: patch });
      const idx = cache[name].findIndex((x) => x.id === id);
      if (idx === -1) return null;
      cache[name][idx] = { ...cache[name][idx], ...patch };
      return cache[name][idx];
    },
    async remove(id) {
      await mongoDb.collection(name).deleteOne({ id });
      const before = cache[name].length;
      cache[name] = cache[name].filter((x) => x.id !== id);
      return cache[name].length < before;
    },
    // Bulk versions (used by the recycle bin: delete / restore many at once)
    async insertMany(docs) {
      if (!docs.length) return 0;
      await mongoDb.collection(name).insertMany(docs.map((d) => ({ ...d })));
      cache[name].push(...docs);
      return docs.length;
    },
    async removeMany(ids) {
      if (!ids.length) return 0;
      const set = new Set(ids);
      await mongoDb.collection(name).deleteMany({ id: { $in: ids } });
      const before = cache[name].length;
      cache[name] = cache[name].filter((x) => !set.has(x.id));
      return before - cache[name].length;
    }
  };
}

module.exports = {
  connect,
  saveEvidence,
  getEvidence,
  trashEvidence,
  restoreEvidence,
  deleteEvidence,
  trash,
  users: makeCollection('users'),
  classes: makeCollection('classes'),
  quizzes: makeCollection('quizzes'),
  attempts: makeCollection('attempts'),
  proctorEvents: makeCollection('proctorEvents'),
  attendance: makeCollection('attendance')
};
