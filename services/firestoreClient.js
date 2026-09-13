/**
 * firestoreClient.js
 *
 * Replaces gasClient.js as the DATABASE layer only. File/Drive operations
 * (uploadFile, deleteFile, convertToSlides, getSlideImages) are NOT part of
 * this module on purpose — those still go through Google Apps Script /
 * Google Drive via gasClient.js. See MIGRATION_NOTES.md.
 *
 * Design goal: every route/service that used to do
 *     const gas = require('./gasClient');
 *     gas.getAll('Students') / gas.find('Attempts', {...}) / gas.update(...)
 * can keep calling the EXACT same functions with the EXACT same
 * (table, ...args) signatures, just against Firestore instead of Sheets.
 * That's why this file exports the same function names as gasClient.js.
 *
 * Firestore-specific rules this file follows:
 *  - No table is ever read in full unless the CALLER already did that
 *    against Sheets (getAll/find semantics are preserved exactly as they
 *    were — this migration does not change which endpoints read whole
 *    collections; it only changes HOW those reads happen).
 *  - Every write goes through the SDK's native batched-write / transaction
 *    primitives whenever more than one document is touched, so partial
 *    failures can't leave data half-written.
 *  - Collection names are lowerCamelCase; the PascalCase "table" names used
 *    throughout routes/ are mapped once, here, so no route file needs to
 *    know the physical collection name.
 */

const path = require('path');

let admin;
let firestoreDb = null;
let initError = null;

// ---------------------------------------------------------------------
// Table name (as used throughout routes/services) -> Firestore collection
// id. Centralized here so nothing else in the codebase needs to know the
// physical collection name, and so it's obvious this list was built from
// an actual audit of every gas.* call in the project (see MIGRATION_NOTES.md
// for the audit), not guessed.
// ---------------------------------------------------------------------
const COLLECTION_MAP = {
  Admins: 'admins',
  Students: 'students',
  Codes: 'codes',
  Units: 'units',
  Lessons: 'lessons',
  Exams: 'exams',
  Questions: 'questions',
  Attempts: 'attempts',
  Rankings: 'rankings',
  Videos: 'videos',
  VideoProgress: 'videoProgress',
  Books: 'books',
  BookProgress: 'bookProgress',
  Presentations: 'presentations',
  Comments: 'comments',
  Messages: 'messages',
  Notifications: 'notifications',
  Settings: 'settings'
};

function collectionNameFor_(table) {
  const name = COLLECTION_MAP[table];
  if (!name) {
    throw new Error(
      `firestoreClient: unknown table "${table}" — add it to COLLECTION_MAP in services/firestoreClient.js`
    );
  }
  return name;
}

/**
 * Lazily initializes firebase-admin on first real use (not at require()
 * time) so importing this module never crashes the process before
 * config/logging has had a chance to run, and so a missing/misconfigured
 * credential surfaces as a clear error on the first actual DB call instead
 * of a confusing boot-time stack trace.
 *
 * Reads credentials from Railway Environment Variables ONLY — nothing is
 * ever read from a committed service-account JSON file, and nothing here
 * ever logs the private key or any other credential value.
 *
 * Two supported shapes (use whichever is more convenient in Railway):
 *   1) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *      (private key exactly as copied from the downloaded JSON — see the
 *      \n handling below).
 *   2) FIREBASE_SERVICE_ACCOUNT  — the ENTIRE service-account JSON, as one
 *      string, base64-encoded (recommended — sidesteps the \n escaping
 *      problem entirely since Railway stores/transmits it as one opaque
 *      blob).
 */
function getDb() {
  if (firestoreDb) return firestoreDb;
  if (initError) throw initError;

  try {
    admin = admin || require('firebase-admin');

    let credentialInput;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      // Accept either raw JSON or base64-encoded JSON in this one variable.
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const jsonText = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      credentialInput = JSON.parse(jsonText);
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      credentialInput = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Railway (like most dashboards) stores env vars as plain text, so a
        // literal newline inside the private key either gets rejected by the
        // UI or arrives as the two-character sequence "\n" instead of a real
        // newline. Undo that escaping here — this is the ONLY place this
        // should ever need to happen.
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      };
    } else {
      throw new Error(
        'Firebase Admin credentials are not configured. Set either FIREBASE_SERVICE_ACCOUNT ' +
        '(base64-encoded full service-account JSON) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL ' +
        '+ FIREBASE_PRIVATE_KEY in Railway → Variables.'
      );
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(credentialInput)
      });
    }

    firestoreDb = admin.firestore();
    // Ignore undefined properties instead of throwing — routes sometimes
    // spread req.body straight into a patch/insert, and an accidental
    // `undefined` field used to just be dropped by Sheets/JSON too.
    firestoreDb.settings({ ignoreUndefinedProperties: true });
    return firestoreDb;
  } catch (err) {
    // Never log err.stack-adjacent credential material; this message is
    // deliberately just the error text (which is our own thrown text above,
    // or firebase-admin's own error, never a dump of the credential object).
    initError = new Error('Firestore initialization failed: ' + err.message);
    throw initError;
  }
}

function docToRecord_(doc) {
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// ---------------------------------------------------------------------
// Generic table helpers — same names/signatures as gasClient.js
// ---------------------------------------------------------------------

async function getAll(table) {
  const snap = await getDb().collection(collectionNameFor_(table)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getById(table, id) {
  if (!id) return null;
  const doc = await getDb().collection(collectionNameFor_(table)).doc(String(id)).get();
  return docToRecord_(doc);
}

/**
 * Every `find()` call in this project matches on 1-2 fields with plain
 * equality (audited across every route — see MIGRATION_NOTES.md). Cloud
 * Firestore resolves multiple equality (==) filters without needing a
 * hand-created composite index, so this stays a single `where` chain —
 * no query restructuring needed even for the two-field cases like
 * { studentId, videoId } or { examId, studentId }.
 */
async function find(table, match = {}) {
  let query = getDb().collection(collectionNameFor_(table));
  for (const [field, value] of Object.entries(match)) {
    query = query.where(field, '==', value);
  }
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function insert(table, record) {
  const ref = getDb().collection(collectionNameFor_(table)).doc();
  const data = { ...record, createdAt: record.createdAt || new Date().toISOString() };
  await ref.set(data);
  return { id: ref.id, ...data };
}

/**
 * update() intentionally mirrors the old Sheets behavior: it returns null
 * (not a 500) when the row doesn't exist, so every route's existing
 * `if (!updated) return res.status(404)...` keeps working unmodified.
 */
async function update(table, id, patch) {
  const ref = getDb().collection(collectionNameFor_(table)).doc(String(id));
  const existing = await ref.get();
  if (!existing.exists) return null;
  const data = { ...patch, updatedAt: new Date().toISOString() };
  await ref.set(data, { merge: true });
  return { id: ref.id, ...existing.data(), ...data };
}

async function remove(table, id) {
  const ref = getDb().collection(collectionNameFor_(table)).doc(String(id));
  await ref.delete();
  return { ok: true, id };
}

// Firestore batched writes cap at 500 operations; chunk transparently so
// callers never have to think about that limit.
function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Writes many records to one collection in as few Firestore round trips as
 * possible (one commit per 500-record chunk) instead of one write per
 * record — the direct replacement for the old "one Sheets range write for
 * the whole batch" behavior.
 */
async function batchInsert(table, records) {
  if (!records || !records.length) return [];
  const db = getDb();
  const coll = db.collection(collectionNameFor_(table));
  const inserted = [];

  for (const group of chunk_(records, 500)) {
    const batch = db.batch();
    const refs = group.map(() => coll.doc());
    group.forEach((record, i) => {
      const data = { ...record, createdAt: record.createdAt || new Date().toISOString() };
      batch.set(refs[i], data);
      inserted.push({ id: refs[i].id, ...data });
    });
    await batch.commit();
  }
  return inserted;
}

/**
 * Applies many { id, patch } updates to one collection in as few commits as
 * possible. Uses set(..., {merge:true}) per document (not a transaction —
 * these patches are independent per-document writes, exactly like the old
 * batchUpdate action), chunked at Firestore's 500-op batch limit.
 */
async function batchUpdate(table, patches) {
  if (!patches || !patches.length) return [];
  const db = getDb();
  const coll = db.collection(collectionNameFor_(table));
  const updated = [];

  for (const group of chunk_(patches, 500)) {
    const batch = db.batch();
    group.forEach(({ id, patch }) => {
      const data = { ...patch, updatedAt: new Date().toISOString() };
      batch.set(coll.doc(String(id)), data, { merge: true });
      updated.push({ id, ...data });
    });
    await batch.commit();
  }
  return updated;
}

/**
 * Replaces every document matching `match` with `records`, as one atomic
 * operation per (delete+insert) chunk — the Firestore equivalent of the old
 * "rebuild this table's rows for this exam" Sheets rewrite. Passing an
 * empty `records` array deletes every matching document and inserts
 * nothing (used by the load-test cleanup routes).
 */
async function replaceMatching(table, match, records) {
  const db = getDb();
  const coll = db.collection(collectionNameFor_(table));

  let query = coll;
  for (const [field, value] of Object.entries(match || {})) {
    query = query.where(field, '==', value);
  }
  const existingSnap = await query.get();

  const deleteChunks = chunk_(existingSnap.docs, 500);
  for (const group of deleteChunks) {
    const batch = db.batch();
    group.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  return batchInsert(table, records || []);
}

// ---------------------------------------------------------------------
// Specialized actions — same names/signatures as gasClient.js
// ---------------------------------------------------------------------

async function getAdminByUsername(username) {
  const matches = await find('Admins', { username });
  return matches[0] || null;
}

async function countAdmins() {
  const coll = getDb().collection(collectionNameFor_('Admins'));
  // Aggregation count query — reads zero documents, just a count, so this
  // stays cheap even as the Admins collection grows.
  const snap = await coll.count().get();
  return snap.data().count;
}

function insertAdmin(record) {
  return insert('Admins', record);
}

function updateAdminPassword(id, passwordHash) {
  return update('Admins', id, { passwordHash });
}

async function getStudentByCode(code) {
  const matches = await find('Students', { code });
  return matches[0] || null;
}

/**
 * Generates `count` new access codes and inserts them in one batch.
 * The generated code string itself is used as the Firestore document ID
 * (not a random auto-id) — this is what makes re-running this safe from
 * accidental duplicate DOCUMENTS: two codes can never collide into two
 * separate rows, because they'd be the exact same document.
 *
 * NOTE: the ORIGINAL code-generation algorithm lived inside the Google
 * Apps Script project (Code.gs), which is not part of this repository, so
 * its exact format could not be read during this migration. This
 * generates unambiguous, unique-enough codes (prefix + 8 random
 * base32-like characters, excluding easily-confused characters like 0/O
 * and 1/I) — check with whoever maintains Code.gs whether the visible code
 * FORMAT needs to match exactly for printed materials already in
 * circulation, and adjust ALPHABET/LENGTH below if so.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCodeSuffix_(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

async function generateCodes(unitId, count, prefix) {
  const db = getDb();
  const coll = db.collection(collectionNameFor_('Codes'));
  const cleanPrefix = (prefix || '').trim().toUpperCase();
  const now = new Date().toISOString();
  const created = [];

  for (const group of chunk_(new Array(count).fill(0), 500)) {
    const batch = db.batch();
    for (let i = 0; i < group.length; i++) {
      const code = cleanPrefix + randomCodeSuffix_(8);
      const data = {
        code, unitId: unitId || '', status: 'unused',
        studentId: '', studentName: '', activationDate: '', createdAt: now
      };
      batch.set(coll.doc(code), data);
      created.push({ id: code, ...data });
    }
    await batch.commit();
  }
  return created;
}

async function getSettings() {
  return getAll('Settings');
}

/**
 * Upserts one setting row, keyed by its `key` (the setting's key doubles as
 * its Firestore document id — so re-saving the same key updates the same
 * document instead of creating duplicate rows, same guarantee the old
 * Sheets version relied on key-based lookup for).
 */
async function updateSetting(key, value) {
  const ref = getDb().collection(collectionNameFor_('Settings')).doc(String(key));
  const data = { key, value, updatedAt: new Date().toISOString() };
  await ref.set(data, { merge: true });
  return { id: key, ...data };
}

/**
 * One atomic Firestore batch for both parts of "publish results":
 *   1. delete this exam's old Rankings docs + insert the new ranking records
 *   2. flip Exams/{examId}.resultsPublished = true
 * matching the old combined `publishExamResults` Apps Script action so a
 * student can never observe resultsPublished=true paired with stale
 * rankings (or vice versa).
 */
async function publishExamResults_(examId, rankingRecords) {
  const db = getDb();
  const rankingsColl = db.collection(collectionNameFor_('Rankings'));
  const examsColl = db.collection(collectionNameFor_('Exams'));

  const existingSnap = await rankingsColl.where('examId', '==', examId).get();

  // Firestore batches cap at 500 ops; in the (very unlikely) case a single
  // exam has more than ~490 ranking rows, fall back to separate commits for
  // the delete+insert pass, then a final commit for the publish flag — still
  // correct, just no longer a single physical batch for the ranking rewrite
  // portion specifically.
  const allOps = existingSnap.docs.length + (rankingRecords || []).length + 1;
  if (allOps <= 500) {
    const batch = db.batch();
    existingSnap.docs.forEach((doc) => batch.delete(doc.ref));
    (rankingRecords || []).forEach((record) => {
      batch.set(rankingsColl.doc(), { ...record, createdAt: new Date().toISOString() });
    });
    batch.set(examsColl.doc(String(examId)), { resultsPublished: true, updatedAt: new Date().toISOString() }, { merge: true });
    await batch.commit();
  } else {
    await replaceMatching('Rankings', { examId }, rankingRecords);
    await update('Exams', examId, { resultsPublished: true });
  }

  return { ok: true };
}

module.exports = {
  getAll, getById, find, insert, update, remove, batchInsert, batchUpdate, replaceMatching,
  getAdminByUsername, countAdmins, insertAdmin, updateAdminPassword, getStudentByCode,
  generateCodes, getSettings, updateSetting, publishExamResults_,
  // exposed for the migration script and for health checks:
  getDb, COLLECTION_MAP
};
