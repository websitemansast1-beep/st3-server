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

const dryRun = args.includes('--dry-run');
const validateOnly = args.includes('--validate');
const overwrite = args.includes('--overwrite');

const tablesArg = args.find(x => x.startsWith('--tables='));
const selectedTables = tablesArg
  ? tablesArg
      .split('=')[1]
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  : ALL_TABLES;

function chunk_(arr, size) {
  const result = [];

  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }

  return result;
}

function docIdFor_(table, record) {
  if (table === 'Settings') {
    if (!record.key) {
      throw new Error(
        'Settings row has no "key" field: ' + JSON.stringify(record)
      );
    }

    return String(record.key);
  }

  if (table === 'Codes') {
    if (!record.code) {
      throw new Error(
        'Codes row has no "code" field: ' + JSON.stringify(record)
      );
    }

    return String(record.code);
  }

  if (!record.id) {
    throw new Error(
      'Row in ' + table + ' has no "id" field: ' + JSON.stringify(record)
    );
  }

  return String(record.id);
}

async function readTable_(table) {
  try {
    const rows = await gas.getAll(table);

    if (!Array.isArray(rows)) {
      throw new Error(
        'Google Sheets returned invalid data for ' +
          table +
          ': ' +
          JSON.stringify(rows)
      );
    }

    return rows;
  } catch (error) {
    console.error(
      '  Failed reading ' +
        table +
        ': ' +
        (error.response?.data || error.message || error)
    );

    throw error;
  }
}

async function migrateTable(table) {
  console.log('');
  console.log('▶ ' + table);

  const rows = await readTable_(table);

  console.log('  read ' + rows.length + ' row(s) from Google Sheets');

  const collectionName = COLLECTION_MAP[table];

  if (!collectionName) {
    throw new Error(
      'No Firestore collection mapping found for table: ' + table
    );
  }

  console.log(
    '  Firestore collection: "' + collectionName + '"'
  );

  if (rows.length === 0) {
    console.log('  nothing to migrate');
    return {
      table,
      read: 0,
      written: 0,
      skipped: 0
    };
  }

  if (dryRun) {
    console.log(
      '  [dry-run] would write up to ' +
        rows.length +
        ' document(s) to Firestore collection "' +
        collectionName +
        '"'
    );

    console.log(
      '  [dry-run] sample row: ' +
        JSON.stringify(rows[0]).slice(0, 1000)
    );

    return {
      table,
      read: rows.length,
      written: 0,
      skipped: 0
    };
  }

  const db = getDb();
  const collection = db.collection(collectionName);

  let existingIds = new Set();

  if (!overwrite) {
    console.log('  checking existing Firestore documents...');

    const existingSnapshot = await collection.get();

    existingIds = new Set(
      existingSnapshot.docs.map(doc => doc.id)
    );

    console.log(
      '  found ' + existingIds.size + ' existing document(s)'
    );
  }

  let written = 0;
  let skipped = 0;

  const batches = chunk_(rows, 500);

  for (const batchRows of batches) {
    const batch = db.batch();

    let batchWriteCount = 0;

    for (const record of batchRows) {
      try {
        const docId = docIdFor_(table, record);

        if (!overwrite && existingIds.has(docId)) {
          skipped++;
          continue;
        }

        const ref = collection.doc(docId);

        batch.set(
          ref,
          {
            ...record,
            _migratedFrom: table,
            _migratedAt: new Date().toISOString()
          },
          {
            merge: true
          }
        );

        batchWriteCount++;
      } catch (error) {
        console.error(
          '  skipped row: ' +
            (error.message || error)
        );

        skipped++;
      }
    }

    if (batchWriteCount > 0) {
      await batch.commit();
      written += batchWriteCount;
    }

    console.log(
      '  written ' +
        written +
        '/' +
        rows.length +
        ' | skipped ' +
        skipped
    );
  }

  return {
    table,
    read: rows.length,
    written,
    skipped
  };
}

async function validateTable(table) {
  console.log('');
  console.log('▶ Validate ' + table);

  try {
    const rows = await readTable_(table);

    const collectionName = COLLECTION_MAP[table];

    if (!collectionName) {
      throw new Error(
        'No Firestore collection mapping found for table: ' + table
      );
    }

    const db = getDb();
    const snapshot = await db.collection(collectionName).get();

    console.log(
      '  Sheets: ' +
        rows.length +
        ' row(s)'
    );

    console.log(
      '  Firestore: ' +
        snapshot.size +
        ' document(s)'
    );

    if (rows.length === snapshot.size) {
      console.log('  OK');
    } else {
      console.log('  COUNT MISMATCH');
    }

    return {
      table,
      sheets: rows.length,
      firestore: snapshot.size,
      match: rows.length === snapshot.size
    };
  } catch (error) {
    console.error(
      '  validation failed: ' +
        (error.response?.data || error.message || error)
    );

    return {
      table,
      error: error.message || String(error)
    };
  }
}

async function main() {
  console.log('');
  console.log('='.repeat(70));
  console.log('Sheets -> Firestore migration');
  console.log(
    validateOnly
      ? 'Mode: VALIDATE'
      : dryRun
      ? 'Mode: DRY RUN (no writes)'
      : overwrite
      ? 'Mode: MIGRATE + OVERWRITE'
      : 'Mode: MIGRATE'
  );
  console.log('Tables: ' + selectedTables.join(', '));
  console.log('='.repeat(70));

  const results = [];

  for (const table of selectedTables) {
    try {
      if (validateOnly) {
        const result = await validateTable(table);
        results.push(result);
      } else {
        const result = await migrateTable(table);
        results.push(result);
      }
    } catch (error) {
      console.error('');
      console.error(
        '❌ ' +
          table +
          ' failed: ' +
          (error.response?.data || error.message || error)
      );

      results.push({
        table,
        error: error.message || String(error)
      });

      console.log(
        '  continuing with next table...'
      );
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  for (const result of results) {
    if (validateOnly) {
      if (result.error) {
        console.log(
          '❌ ' +
            result.table +
            ': ' +
            result.error
        );
      } else {
        console.log(
          (result.match ? '✅ ' : '⚠️ ') +
            result.table +
            ': Sheets=' +
            result.sheets +
            ' Firestore=' +
            result.firestore
        );
      }
    } else {
      if (result.error) {
        console.log(
          '❌ ' +
            result.table +
            ': ' +
            result.error
        );
      } else {
        console.log(
          '✅ ' +
            result.table +
            ': read=' +
            result.read +
            ', written=' +
            result.written +
            ', skipped=' +
            result.skipped
        );
      }
    }
  }

  console.log('='.repeat(70));
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('');
    console.error(
      'FATAL ERROR:',
      error.message || error
    );

    process.exit(1);
  });
