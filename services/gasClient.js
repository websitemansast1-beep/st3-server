const axios = require('axios');
const config = require('../config/config');

// Fallback in-memory storage when GAS is unavailable
const fallbackStore = {
  Admins: [],
  Students: [],
  Codes: [],
  Units: [],
  Exams: [],
  Attempts: [],
  Questions: [],
  Videos: [],
  VideoProgress: [],
  Settings: [],
  Books: [],
  Notifications: []
};

let gasAvailable = true;
let lastGasError = null;

// ---------- Concurrency limiter ----------
// Google Apps Script Web Apps cap SIMULTANEOUS executions at roughly 30
// per script (a Google quota, not something in our control — confirmed
// current as of 2026). A burst of many students doing ANYTHING at once
// (logging in, opening an exam page, loading the dashboard) fires one
// Apps Script call per action; without a limit, a big enough burst would
// simply exceed that ceiling and Apps Script itself starts erroring or
// stalling requests. Instead, every outgoing call acquires a "slot" from
// a small pool here first — extra calls wait in an in-memory queue and
// get served in order as slots free up, so nobody ever overwhelms Apps
// Script, they just wait their turn (typically a fraction of a second,
// even under a big burst, since each call only holds its slot for the
// duration of one Apps Script execution).
//
// This is deliberately generic — it protects EVERY call through
// fetchFromGas_ (reads that miss cache, logins, submissions, page
// loads, everything), not just one endpoint, per the requirement that
// "anything that could be slow gets this same spreading-out treatment".
const MAX_CONCURRENT_GAS_CALLS = parseInt(process.env.GAS_MAX_CONCURRENT, 10) || 20; // stays safely under Google's ~30 cap
const GAS_QUEUE_TIMEOUT_MS = parseInt(process.env.GAS_QUEUE_TIMEOUT_MS, 10) || 45000; // never leave a request hanging forever
let activeGasCalls = 0;
const gasCallQueue = []; // FIFO of { resolve, reject, timer, enqueuedAt }
const gasConcurrencyStats = { maxActiveSeen: 0, maxQueueSeen: 0, totalTimeouts: 0 };

function acquireGasSlot_() {
  if (activeGasCalls < MAX_CONCURRENT_GAS_CALLS) {
    activeGasCalls++;
    if (activeGasCalls > gasConcurrencyStats.maxActiveSeen) gasConcurrencyStats.maxActiveSeen = activeGasCalls;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, enqueuedAt: Date.now() };
    entry.timer = setTimeout(() => {
      const idx = gasCallQueue.indexOf(entry);
      if (idx !== -1) {
        gasCallQueue.splice(idx, 1);
        gasConcurrencyStats.totalTimeouts++;
        reject(new Error('الموقع مزدحم جدًا دلوقتي — جرّب تاني بعد شوية'));
      }
    }, GAS_QUEUE_TIMEOUT_MS);
    gasCallQueue.push(entry);
    if (gasCallQueue.length > gasConcurrencyStats.maxQueueSeen) gasConcurrencyStats.maxQueueSeen = gasCallQueue.length;
  });
}

function releaseGasSlot_() {
  activeGasCalls--;
  const next = gasCallQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    activeGasCalls++;
    next.resolve();
  }
}

function getGasConcurrencyStats() {
  return { ...gasConcurrencyStats, activeNow: activeGasCalls, queuedNow: gasCallQueue.length, cap: MAX_CONCURRENT_GAS_CALLS };
}

// ---------- Short-lived read cache ----------
// Google Sheets reads go through Apps Script and are the slowest part of
// every page load (roughly 1-3s per call, regardless of how simple the
// read is). Two things matter when many students hit the site together:
//
// 1. STALE-WHILE-REVALIDATE: once a value has been fetched once, we keep
//    serving it instantly even after it "expires" while a background
//    refresh quietly replaces it — nobody ever waits on Apps Script for
//    data that's only a few seconds out of date.
// 2. REQUEST COALESCING: if 100 students ask for the same thing (e.g. the
//    published course list) at the same moment and nothing is cached yet,
//    only ONE request actually goes to Apps Script — everyone else waits
//    on that same in-flight promise instead of firing 100 separate calls
//    and hammering the sheet (and Apps Script's execution quota) at once.
const READ_CACHE_FRESH_MS = 20000;   // serve instantly, no network call at all
const READ_CACHE_STALE_MS = 120000;  // serve instantly but refresh quietly in the background
const readCache = new Map();  // key -> { value, cachedAt }
const inFlight = new Map();   // key -> Promise (de-dupes concurrent identical requests)
const READ_ACTIONS = new Set([
  'getAll', 'getById', 'find', 'getAdminByUsername', 'countAdmins',
  'getStudentByCode', 'getSettings'
]);

function cacheKey(action, payload) {
  return action + ':' + JSON.stringify(payload || {});
}

function clearReadCache() {
  readCache.clear();
  // Deliberately leave `inFlight` alone — requests already in flight still
  // need to resolve to whoever is awaiting them.
}

async function fetchFromGas_(action, payload) {
  // Wait for a concurrency slot BEFORE spending any network time — this
  // is what actually spreads a burst out instead of firing everything
  // at Apps Script at once and letting it start failing requests.
  await acquireGasSlot_();
  try {
    const response = await axios.post(
      config.gas.endpointUrl,
      { apiKey: config.gas.apiKey, action, payload },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const body = response.data;
    if (!body.ok) {
      throw new Error(body.error || 'Unknown Google Apps Script error');
    }
    return body.data;
  } finally {
    releaseGasSlot_();
  }
}

/**
 * Every call to Google Sheets/Drive goes through this single function.
 * The Apps Script Web App is the only thing that ever touches the sheet.
 */
async function callGas(action, payload = {}) {
  if (!config.gas.endpointUrl) {
    throw new Error('GAS_ENDPOINT_URL is not configured in .env');
  }

  const isRead = READ_ACTIONS.has(action);
  if (!isRead) {
    // Writes always go straight through, then invalidate every cached
    // read so nobody sees stale data after a change.
    const data = await fetchFromGas_(action, payload);
    clearReadCache();
    return data;
  }

  const key = cacheKey(action, payload);
  const cached = readCache.get(key);
  const now = Date.now();

  if (cached) {
    const age = now - cached.cachedAt;
    if (age < READ_CACHE_FRESH_MS) {
      return cached.value; // fully fresh — instant, no network call
    }
    if (age < READ_CACHE_STALE_MS) {
      // Stale but usable: hand back the cached value immediately, and
      // kick off (at most one) background refresh for next time.
      if (!inFlight.has(key)) {
        const refresh = fetchFromGas_(action, payload)
          .then((data) => { readCache.set(key, { value: data, cachedAt: Date.now() }); return data; })
          .catch(() => {}) // a failed background refresh just keeps serving the old value
          .finally(() => inFlight.delete(key));
        inFlight.set(key, refresh);
      }
      return cached.value;
    }
    // Older than the stale window — fall through to a real, blocking fetch.
  }

  // Nothing usable cached: dedupe concurrent identical requests so a burst
  // of simultaneous students only triggers one real Apps Script call.
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }
  const request = fetchFromGas_(action, payload)
    .then((data) => { readCache.set(key, { value: data, cachedAt: Date.now() }); return data; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

// ---------- Generic table helpers ----------
const getAll = (table) => callGas('getAll', { table });
const getById = (table, id) => callGas('getById', { table, id });
const find = (table, match) => callGas('find', { table, match });
const insert = (table, record) => callGas('insert', { table, record });
// Writes many rows to a sheet in ONE Apps Script call / ONE Sheets range
// write, instead of N separate insert() round trips. This is what lets a
// burst of simultaneous submissions (or a ranking rebuild) turn into a
// single Sheets write instead of one write per student.
const batchInsert = (table, records) => callGas('batchInsert', { table, records });
// Replaces every row matching `match` with `records` in one Sheets write —
// used to rebuild a per-exam Rankings snapshot in a single call.
const replaceMatching = (table, match, records) => callGas('replaceMatching', { table, match, records });
const update = (table, id, patch) => callGas('update', { table, id, patch });
// Applies many { id, patch } updates in ONE Apps Script call / ONE Sheets
// read+write, instead of N separate update() round trips. This is what the
// submission queue's batch processor uses to flush a whole batch of graded
// attempts (score/status/finishTime/...) in a single Sheets operation.
const batchUpdate = (table, patches) => callGas('batchUpdate', { table, patches });
// One Apps Script round trip for both the ranking rewrite AND the
// resultsPublished flip — see the matching case in Code.gs for why.
const publishExamResults_ = (examId, rankingRecords) => callGas('publishExamResults', { examId, rankingRecords });
const remove = (table, id) => callGas('delete', { table, id });

// ---------- Specialized actions ----------
const getAdminByUsername = (username) => callGas('getAdminByUsername', { username });
const countAdmins = () => callGas('countAdmins');
const insertAdmin = (record) => callGas('insertAdmin', { record });
const updateAdminPassword = (id, passwordHash) => callGas('updateAdminPassword', { id, passwordHash });
const getStudentByCode = (code) => callGas('getStudentByCode', { code });
const uploadFile = (payload) => callGas('uploadFile', payload);
const deleteFile = (fileId) => callGas('deleteFile', { fileId });
const generateCodes = (unitId, count, prefix) => callGas('generateCodes', { unitId, count, prefix });
const getSettings = () => callGas('getSettings');
const updateSetting = (key, value) => callGas('updateSetting', { key, value });

// Fallback handler when GAS is unavailable
function handleFallback(action, table, payload) {
  const store = fallbackStore[table] || [];
  if (action === 'getAll') return { ok: true, data: store };
  if (action === 'getById') {
    const item = store.find(x => x.id === payload.id);
    return item ? { ok: true, data: item } : { ok: false, error: 'Not found' };
  }
  if (action === 'find') {
    const keys = Object.keys(payload);
    const results = store.filter(x => keys.every(k => x[k] == payload[k]));
    return { ok: true, data: results };
  }
  if (action === 'insert') {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const item = { id, ...payload, createdAt: new Date().toISOString() };
    store.push(item);
    return { ok: true, data: item };
  }
  if (action === 'update') {
    const idx = store.findIndex(x => x.id === payload.id);
    if (idx === -1) return { ok: false, error: 'Not found' };
    store[idx] = { ...store[idx], ...payload, updatedAt: new Date().toISOString() };
    return { ok: true, data: store[idx] };
  }
  if (action === 'delete') {
    const idx = store.findIndex(x => x.id === payload.id);
    if (idx === -1) return { ok: false, error: 'Not found' };
    store.splice(idx, 1);
    return { ok: true };
  }
  if (action === 'batchInsert') {
    const items = (payload.records || []).map((rec) => {
      const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
      const item = { id, ...rec, createdAt: new Date().toISOString() };
      store.push(item);
      return item;
    });
    return { ok: true, data: items };
  }
  if (action === 'batchUpdate') {
    const results = (payload.patches || []).map((p) => {
      const idx = store.findIndex(x => x.id === p.id);
      if (idx === -1) return null;
      store[idx] = { ...store[idx], ...p.patch, updatedAt: new Date().toISOString() };
      return store[idx];
    });
    return { ok: true, data: results };
  }
  return { ok: false, error: 'Unsupported fallback action' };
}

// Helper to check if GAS is working
function isGasAvailable() { return gasAvailable; }
function getLastGasError() { return lastGasError; }

module.exports = {
  callGas, getAll, getById, find, insert, update, remove, batchInsert, batchUpdate, replaceMatching,
  getAdminByUsername, countAdmins, insertAdmin, updateAdminPassword, getStudentByCode, uploadFile, deleteFile,
  generateCodes, getSettings, updateSetting, publishExamResults_, getGasConcurrencyStats
};
