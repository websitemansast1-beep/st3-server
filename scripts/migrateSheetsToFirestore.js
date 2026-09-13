/**
 * scripts/migrateSheetsToFirestore.js
 *
 * ONE-TIME, MANUAL migration of the existing Google Sheets data (read
 * through the same gasClient.js/Apps Script endpoint the app has always
 * used) into Firestore. This script:
 *
 *   - NEVER runs automatically (not wired into npm start, not wired into
 *     any deploy hook). You run it yourself, on purpose, from a shell.
 *   - NEVER deletes or modifies anything in Google Sheets. It only reads.
 *   - Preserves every row's original id as the Firestore document id —
 *     this is what keeps every foreign-key-style reference (studentId,
 *     examId, unitId, ...) working unchanged after the move.
 *   - Is safe to re-run: by default it SKIPS any document that already
 *     exists in Firestore (so re-running after a partial run, or after
 *     fixing one bad row, does not create duplicates and does not clobber
 *     anything already migrated). Pass --overwrite to force-overwrite
 *     instead.
 *   - Supports --dry-run to see exactly what WOULD happen with zero writes.
 *
 * Usage:
 *   node scripts/migrateSheetsToFirestore.js --dry-run
 *   node scripts/migrateSheetsToFirestore.js --validate
 *   node scripts/migrateSheetsToFirestore.js
 *   node scripts/migrateSheetsToFirestore.js --tables=Students,Codes
 *   node scripts/migrateSheetsToFirestore.js --overwrite
 *
 * Requires the SAME environment variables as the running server: the
 * GAS_* vars (to read from Sheets) AND the FIREBASE_* vars (to write to
 * Firestore) — see MIGRATION_NOTES.md for the full list.
 */

const gas = require('../services/gasClient');
const { getDb, COLLECTION_MAP } = require('../services/firestoreClient');

// Order matters only for readability of the progress log — Firestore
// writes here don't depend on other collections already existing, so this
// is not a strict dependency order the way a relational-DB migration
// would need.
const ALL_TABLES = [
  'Admins', 'Students', 'Codes', 'Units', 'Lessons', 'Videos', 'VideoProgress',
  'Books', 'BookProgress', 'Presentations', 'Exams', 'Questions', 'Attempts',
  'Rankings', 'Comments', 'Messages', 'Notifications', 'Settings'
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VALIDATE_ONLY = args.includes('--validate');
const OVERWRITE = args.includes('--overwrite');
const tablesArg = args.find((a) => a.startsWith('--tables='));
const TABLES = tablesArg
  ? tablesArg.replace('--tables=', '').split(',').map((t) => t.trim()).filter(Boolean)
  : ALL_TABLES;

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Settings is special-cased: in Sheets it's a plain key/value table with an
 * auto id per row; in Firestore we key it by `key` itself (see
 * firestoreClient.updateSetting) so lookups/updates are O(1) by key instead
 * of a table scan. The migration follows that same rule instead of
 * preserving the Sheets row id for this one collection.
 */
function docIdFor_(table, record) {
  if (table === 'Settings' && record.key) return String(record.key);
  if (table === 'Codes' && record.code) return String(record.code);
  if (!record.id) {
    throw new Error(`Row in ${table} has no "id" field — cannot migrate safely without one: ${JSON.stringify(record)}`);
  }
  return String(record.id);
}

async function migrateTable(table) {
  const collectionName = COLLECTION_MAP[table];
  if (!collectionName) {
    console.warn(`  ⚠️  Skipping "${table}" — not in COLLECTION_MAP (add it to firestoreClient.js first).`);
    return { table, read: 0, written: 0, skipped: 0, errors: [] };
  }

  console.log(`\n▶ ${table}`);
  const rows = await gas.getAll(table);
  console.log(`  read ${rows.length} row(s) from Google Sheets`);

  if (DRY_RUN) {
    console.log(`  [dry-run] would write up to ${rows.length} document(s) to Firestore collection "${collectionName}"`);
    if (rows[0]) console.log(`  [dry-run] sample row:`, JSON.stringify(rows[0]).slice(0, 300));
    return { table, read: rows.length, written: 0, skipped: 0, errors: [] };
  }

  const db = getDb();
  const coll = db.collection(collectionName);

  // Find out what's already there so a re-run doesn't duplicate or
  // (unless --overwrite) clobber anything.
  let existingIds = new Set();
  if (!OVERWRITE) {
    const existingSnap = await coll.get();
    existingIds = new Set(existingSnap.docs.map((d) => d.id));
  }

  const errors = [];
  let written = 0;
  let skipped = 0;

  const toWrite = [];
  for (const record of rows) {
    let id;
    try {
      id = docIdFor_(table, record);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (!OVERWRITE && existingIds.has(id)) {
      skipped++;
      continue;
    }
    toWrite.push({ id, record });
  }

  for (const group of chunk_(toWrite, 500)) {
    const batch = db.batch();
    for (const { id, record } of group) {
      const { id: _drop, ...rest } = record; // don't store "id" twice — it's the doc id
      batch.set(coll.doc(id), rest, { merge: OVERWRITE });
    }
    await batch.commit();
    written += group.length;
    process.stdout.write(`  written ${written}/${toWrite.length}\r`);
  }
  if (toWrite.length) console.log(`  written ${written}/${toWrite.length}`);
  if (skipped) console.log(`  skipped ${skipped} already-migrated document(s) (use --overwrite to replace them)`);
  if (errors.length) {
    console.log(`  ⚠️  ${errors.length} row(s) had errors and were NOT migrated:`);
    errors.slice(0, 10).forEach((e) => console.log('     -', e));
  }

  return { table, read: rows.length, written, skipped, errors };
}

async function validateTable(table) {
  const collectionName = COLLECTION_MAP[table];
  if (!collectionName) return { table, sheets: 0, firestore: 0, match: true, skipped: true };

  const [sheetsRows, firestoreSnap] = await Promise.all([
    gas.getAll(table),
    getDb().collection(collectionName).count().get()
  ]);
  const firestoreCount = firestoreSnap.data().count;
  return { table, sheets: sheetsRows.length, firestore: firestoreCount, match: sheetsRows.length === firestoreCount };
}

async function main() {
  console.log('='.repeat(70));
  console.log('Sheets -> Firestore migration');
  console.log('Mode:', VALIDATE_ONLY ? 'VALIDATE ONLY (no writes)' : DRY_RUN ? 'DRY RUN (no writes)' : (OVERWRITE ? 'LIVE (overwrite existing)' : 'LIVE (skip existing)'));
  console.log('Tables:', TABLES.join(', '));
  console.log('='.repeat(70));

  if (VALIDATE_ONLY) {
    const results = await Promise.all(TABLES.map(validateTable));
    console.log('\nTable'.padEnd(20), 'Sheets'.padEnd(10), 'Firestore'.padEnd(10), 'Match');
    results.forEach((r) => {
      if (r.skipped) return;
      console.log(r.table.padEnd(20), String(r.sheets).padEnd(10), String(r.firestore).padEnd(10), r.match ? '✅' : '❌ MISMATCH');
    });
    const mismatches = results.filter((r) => !r.skipped && !r.match);
    if (mismatches.length) {
      console.log(`\n⚠️  ${mismatches.length} table(s) have a row-count mismatch — re-run the migration for those tables.`);
      process.exitCode = 1;
    } else {
      console.log('\n✅ All row counts match.');
    }
    return;
  }

  const summary = [];
  for (const table of TABLES) {
    summary.push(await migrateTable(table));
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  summary.forEach((s) => {
    console.log(`${s.table.padEnd(18)} read=${String(s.read).padEnd(6)} written=${String(s.written).padEnd(6)} skipped=${String(s.skipped).padEnd(6)} errors=${s.errors.length}`);
  });

  if (!DRY_RUN) {
    console.log('\nNext step: node scripts/migrateSheetsToFirestore.js --validate');
    console.log('Google Sheets has NOT been modified — it remains available as a backup.');
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  });
