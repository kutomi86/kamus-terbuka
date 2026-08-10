/**
 * tests/databaseTester.js
 * Integration test for verifying SQLite initialization, dummy row insertion,
 * reading verification, and cleanup matching the kamus-terbuka project structure.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Resolve paths relative to project root (since this script sits inside /tests)
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(PROJECT_ROOT, 'src', 'database');
const DB_PATH = path.join(DB_DIR, 'kamus-terbuka.db');
const BUILD_SCRIPT_PATH = path.join(PROJECT_ROOT, 'helpers', 'enricher', 'build-db.js');

function runTest() {
  console.log('🧪 Starting database functionality test...\n');

  // 1. Verify helper script import functionality
  if (!fs.existsSync(BUILD_SCRIPT_PATH)) {
    throw new Error(`Build script not found at expected location: ${BUILD_SCRIPT_PATH}`);
  }
  const buildDatabase = require(BUILD_SCRIPT_PATH);
  console.log(`[PASS] Successfully imported buildDatabase module from ${path.relative(PROJECT_ROOT, BUILD_SCRIPT_PATH)}`);

  // 2. Ensure target directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    console.log(`[PASS] Created directory: ${path.relative(PROJECT_ROOT, DB_DIR)}`);
  }

  const db = new Database(DB_PATH);

  // Initialize table structure if non-existent
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kata TEXT NOT NULL,
      lema TEXT,
      pelafalan TEXT,
      etimologi TEXT,
      makna TEXT,
      tags_kelas TEXT,
      tags_bahasa TEXT,
      tags_bidang TEXT,
      tags_ragam TEXT,
      tags_sumber TEXT NOT NULL,
      contoh TEXT,
      turunan TEXT,
      gabungan_kata TEXT,
      peribahasa TEXT,
      kiasan TEXT,
      varian TEXT,
      dasar TEXT
    );
  `);
  console.log(`[PASS] Database file verified/created at: ${path.relative(PROJECT_ROOT, DB_PATH)}`);

  // 3. Insert Dummy Entry matching exact structure
  const dummyEntry = {
    kata: 'dummy_test_word',
    lema: 'dummy_test_word',
    pelafalan: 'du-mmy',
    etimologi: 'latin',
    makna: 'entri uji coba untuk testing database pipeline',
    tags_kelas: 'Nomina',
    tags_bahasa: 'Ind',
    tags_bidang: 'TI',
    tags_ragam: 'cak',
    tags_sumber: 'TEST_SUITE',
    contoh: 'ini adalah contoh kata dummy_test_word',
    turunan: 'mencoba_dummy',
    gabungan_kata: 'dummy kata',
    peribahasa: 'seperti dummy',
    kiasan: 'kiasan dummy',
    varian: 'dumi',
    dasar: 'dummy'
  };

  const insertStmt = db.prepare(`
    INSERT INTO entries (
      kata, lema, pelafalan, etimologi, makna,
      tags_kelas, tags_bahasa, tags_bidang, tags_ragam, tags_sumber,
      contoh, turunan, gabungan_kata, peribahasa,
      kiasan, varian, dasar
    ) VALUES (
      @kata, @lema, @pelafalan, @etimologi, @makna,
      @tags_kelas, @tags_bahasa, @tags_bidang, @tags_ragam, @tags_sumber,
      @contoh, @turunan, @gabungan_kata, @peribahasa,
      @kiasan, @varian, @dasar
    )
  `);

  const info = insertStmt.run(dummyEntry);
  const dummyId = info.lastInsertRowid;
  console.log(`[PASS] Successfully inserted dummy entry with ID: ${dummyId}`);

  // 4. Read and log the inserted entry
  const selectStmt = db.prepare('SELECT * FROM entries WHERE id = ?');
  const fetchedRow = selectStmt.get(dummyId);

  console.log('\n📖 Retrieved Entry from Database:');
  console.dir(fetchedRow, { depth: null, colors: true });

  if (fetchedRow && fetchedRow.kata === 'dummy_test_word') {
    console.log('\n[PASS] Data verification succeeded!');
  } else {
    throw new Error('Data verification failed: fetched row does not match dummy data.');
  }

  // 5. Clean up by deleting the dummy entry
  db.prepare('DELETE FROM entries WHERE id = ?').run(dummyId);

  const checkDeleted = selectStmt.get(dummyId);
  if (!checkDeleted) {
    console.log('[PASS] Successfully deleted dummy entry from database.');
  } else {
    throw new Error('Cleanup failed: entry still exists in database.');
  }

  db.close();
  console.log('\n🎉 All database functional tests passed!');
}

try {
  runTest();
} catch (err) {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
}