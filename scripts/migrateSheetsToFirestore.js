```js
const gas = require('../services/gasClient');
const { getDb, COLLECTION_MAP } = require('../services/firestoreClient');

const ALL_TABLES = [
  'Admins',
  'Students',
  'Codes',
  'Units',
  'Lessons',
  'Videos',
  'VideoProgress',
  'Books',
  'BookProgress',
  'Presentations',
  'Exams',
  'Questions',
  'Attempts',
  'Rankings',
  'Comments',
  'Messages',
  'Notifications',
  'Settings'
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VALIDATE_ONLY = args.includes('--validate');
const OVERWRITE = args.includes('--overwrite');

const tablesArg = args.find((a) => a.startsWith('--tables='));

const TABLES = tablesArg
  ? tablesArg
      .replace('--tables=', '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  : ALL_TABLES;

function chunk_(arr, size) {
  const out = [];

  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }

  return out;
}

function docIdFor_(table, record) {
  if (table === 'Settings' && record.key) {
    return String(record.key);
  }

  if (table === 'Codes' && record.code) {
    return String(record.code);
  }

  if (!record.id) {
    throw new Error(
      `Row in ${table} has no "id" field: ${JSON.stringify(record)}`
    );
  }

  return String(record.id);
}

async function readTable_(table) {
  try {
    const rows = await gas.getAll(table);

    return {
      ok: true,
      rows
    };
  } catch (err) {
    const status = err.response?.status || '';
    const data = err.response?.data || err.message;

    console.error(
      `  ERROR reading ${table}:`,
      status,
      data
    );

    return {
      ok: false,
      rows: [],
      error: err.message
    };
  }
}

async function migrateTable(table) {
  const collectionName = COLLECTION_MAP[table];

  if (!collectionName) {
    console.warn(
      `  Skipping "${table}" because it is not in COLLECTION_MAP.`
    );

    return {
      table,
      read: 0,
      written: 0,
      skipped: 0,
      errors: ['Missing COLLECTION_MAP entry']
    };
  }

  console.log(`\n▶ ${table}`);

  const result = await readTable_(table);

  if (!result.ok) {
    console.log(
      `  Skipping ${table} because it could not be read.`
    );

    return {
      table,
      read: 0,
      written: 0,
      skipped: 0,
      errors: [result.error]
    };
  }

  const rows = result.rows;

  console.log(
    `  read ${rows.length} row(s) from Google Sheets`
  );

  if (DRY_RUN) {
    console.log(
      `  [dry-run] would write ${rows.length} document(s) to Firestore collection "${collectionName}"`
    );

    if (rows[0]) {
      console.log(
        `  [dry-run] sample row:`,
        JSON.stringify(rows[0]).slice(0, 500)
      );
    }

    return {
      table,
      read: rows.length,
      written: 0,
      skipped: 0,
      errors: []
    };
  }

  const db = getDb();
  const coll = db.collection(collectionName);

  let existingIds = new Set();

  if (!OVERWRITE) {
    const existingSnap = await coll.get();

    existingIds = new Set(
      existingSnap.docs.map((doc) => doc.id)
    );
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

    toWrite.push({
      id,
      record
    });
  }

  for (const group of chunk_(toWrite, 500)) {
    const batch = db.batch();

    for (const item of group) {
      const id = item.id;
      const record = item.record;

      const rest = {
        ...record
      };

      delete rest.id;

      batch.set(
        coll.doc(id),
        rest,
        {
          merge: OVERWRITE
        }
      );
    }

    await batch.commit();

    written += group.length;

    process.stdout.write(
      `  written ${written}/${toWrite.length}\r`
    );
  }

  if (toWrite.length > 0) {
    console.log(
      `  written ${written}/${toWrite.length}`
    );
  }

  if (skipped > 0) {
    console.log(
      `  skipped ${skipped} already-migrated document(s)`
    );
  }

  if (errors.length > 0) {
    console.log(
      `  WARNING: ${errors.length} row(s) had errors`
    );

    errors
      .slice(0, 10)
      .forEach((error) => {
        console.log(`     - ${error}`);
      });
  }

  return {
    table,
    read: rows.length,
    written,
    skipped,
    errors
  };
}

async function validateTable(table) {
  const collectionName = COLLECTION_MAP[table];

  if (!collectionName) {
    return {
      table,
      sheets: 0,
      firestore: 0,
      match: true,
      skipped: true
    };
  }

  try {
    const sheetsRows = await gas.getAll(table);

    const firestoreSnap = await getDb()
      .collection(collectionName)
      .count()
      .get();

    const firestoreCount =
      firestoreSnap.data().count;

    return {
      table,
      sheets: sheetsRows.length,
      firestore: firestoreCount,
      match: sheetsRows.length === firestoreCount
    };
  } catch (err) {
    return {
      table,
      sheets: 0,
      firestore: 0,
      match: false,
      error: err.message
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('Sheets -> Firestore migration');

  let mode = 'LIVE (skip existing)';

  if (VALIDATE_ONLY) {
    mode = 'VALIDATE ONLY (no writes)';
  } else if (DRY_RUN) {
    mode = 'DRY RUN (no writes)';
  } else if (OVERWRITE) {
    mode = 'LIVE (overwrite existing)';
  }

  console.log('Mode:', mode);
  console.log('Tables:', TABLES.join(', '));
  console.log('='.repeat(70));

  if (VALIDATE_ONLY) {
    const results = [];

    for (const table of TABLES) {
      console.log(`\nChecking ${table}...`);

      const result = await validateTable(table);

      results.push(result);
    }

    console.log('\nTable'.padEnd(20), 'Sheets'.padEnd(10), 'Firestore'.padEnd(10), 'Match');

    for (const result of results) {
      if (result.skipped) {
        continue;
      }

      if (result.error) {
        console.log(
          result.table.padEnd(20),
          'ERROR'.padEnd(10),
          '-'.padEnd(10),
          'ERROR'
        );

        continue;
      }

      console.log(
        result.table.padEnd(20),
        String(result.sheets).padEnd(10),
        String(result.firestore).padEnd(10),
        result.match ? 'OK' : 'MISMATCH'
      );
    }

    console.log('\nValidation finished.');
    return;
  }

  const summary = [];

  for (const table of TABLES) {
    try {
      const result = await migrateTable(table);

      summary.push(result);
    } catch (err) {
      console.error(
        `\nERROR migrating ${table}:`,
        err.message
      );

      summary.push({
        table,
        read: 0,
        written: 0,
        skipped: 0,
        errors: [err.message]
      });

      console.log(
        'Continuing with the next table...'
      );
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  for (const result of summary) {
    console.log(
      `${result.table.padEnd(18)} read=${String(result.read).padEnd(6)} written=${String(result.written).padEnd(6)} skipped=${String(result.skipped).padEnd(6)} errors=${result.errors.length}`
    );
  }

  if (!DRY_RUN) {
    console.log('\nGoogle Sheets has NOT been modified.');
    console.log('Migration finished.');
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      '\nMigration failed:',
      err.message
    );

    process.exit(1);
  });
```
