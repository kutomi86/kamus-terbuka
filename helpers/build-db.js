/**
 * helpers/build-db.js
 * 
 * Open-Source Project: kamus-terbuka
 * Pipeline script to parse kbbi_v6.1.0_full.csv (~190k rows) and emit 
 * a production-ready SQLite database at src/database/kamus-terbuka.db.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const csv = require('csv-parser');

// Path Configuration
const CSV_PATH = path.join(__dirname, 'datasets', 'kbbi_v6.1.0_full.csv');
const DB_DIR = path.join(__dirname, '..', 'src', 'database');
const DB_PATH = path.join(DB_DIR, 'kamus-terbuka.db');

// Batching & Performance Settings
const BATCH_SIZE = 5000;
const TAGS_SUMBER_DEFAULT = 'KBBI';

// Sanitize string fields: trim whitespace, convert empty strings to NULL
function sanitize(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function buildDatabase(options = {}) {
  const customCsvPath = options.csvPath || CSV_PATH;
  const customDbPath = options.dbPath || DB_PATH;
  const customDbDir = path.dirname(customDbPath);

  console.log('🚀 Starting KBBI SQLite database ingestion...');
  const startTime = Date.now();

  // Ensure target directory exists
  if (!fs.existsSync(customDbDir)) {
    fs.mkdirSync(customDbDir, { recursive: true });
    console.log(`📁 Created target directory: ${customDbDir}`);
  }

  // If old DB exists, remove it for a clean rebuild (unless explicitly disabled)
  if (options.overwrite !== false && fs.existsSync(customDbPath)) {
    fs.unlinkSync(customDbPath);
    console.log(`🗑️ Removed existing database at ${customDbPath}`);
  }

  // Initialize SQLite Database with performance PRAGMAs
  const db = new Database(customDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Schema Setup (tags_sumber placed right after tags_ragam)
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

    CREATE INDEX IF NOT EXISTS idx_kata ON entries(kata);
    CREATE INDEX IF NOT EXISTS idx_lema ON entries(lema);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO entries (
      kata, lema, pelafalan, etimologi, makna,
      tags_kelas, tags_bahasa, tags_bidang, tags_ragam, tags_sumber,
      contoh, turunan, gabungan_kata, peribahasa,
      kiasan, varian, dasar
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertStmt.run(
        row.kata,
        row.lema,
        row.pelafalan,
        row.etimologi,
        row.makna,
        row.tags_kelas,
        row.tags_bahasa,
        row.tags_bidang,
        row.tags_ragam,
        TAGS_SUMBER_DEFAULT,
        row.contoh,
        row.turunan,
        row.gabungan_kata,
        row.peribahasa,
        row.kiasan,
        row.varian,
        row.dasar
      );
    }
  });

  let rowBuffer = [];
  let totalProcessed = 0;
  let malformedCount = 0;

  // Verify file presence before streaming
  if (!fs.existsSync(customCsvPath)) {
    console.error(`❌ CSV File not found at path: ${customCsvPath}`);
    db.close();
    throw new Error(`CSV File not found at path: ${customCsvPath}`);
  }

  return new Promise((resolve, reject) => {
    fs.createReadStream(customCsvPath)
      .pipe(csv())
      .on('data', (row) => {
        const kataClean = sanitize(row.kata);
        if (!kataClean) {
          malformedCount++;
          return;
        }

        rowBuffer.push({
          kata: kataClean,
          lema: sanitize(row.lema),
          pelafalan: sanitize(row.pelafalan),
          etimologi: sanitize(row.etimologi),
          makna: sanitize(row.makna),
          tags_kelas: sanitize(row.tags_kelas),
          tags_bahasa: sanitize(row.tags_bahasa),
          tags_bidang: sanitize(row.tags_bidang),
          tags_ragam: sanitize(row.tags_ragam),
          contoh: sanitize(row.contoh),
          turunan: sanitize(row.turunan),
          gabungan_kata: sanitize(row.gabungan_kata),
          peribahasa: sanitize(row.peribahasa),
          kiasan: sanitize(row.kiasan),
          varian: sanitize(row.varian),
          dasar: sanitize(row.dasar),
        });

        if (rowBuffer.length >= BATCH_SIZE) {
          insertMany(rowBuffer);
          totalProcessed += rowBuffer.length;
          console.log(`📦 Processed ${totalProcessed.toLocaleString()} rows...`);
          rowBuffer = [];
        }
      })
      .on('end', () => {
        if (rowBuffer.length > 0) {
          insertMany(rowBuffer);
          totalProcessed += rowBuffer.length;
          rowBuffer = [];
        }

        db.pragma('optimize');
        db.close();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n✅ Ingestion finished successfully in ${duration}s!`);
        console.log(`📊 Total Entries Inserted: ${totalProcessed.toLocaleString()}`);
        if (malformedCount > 0) {
          console.log(`⚠️ Skipped Malformed Rows: ${malformedCount.toLocaleString()}`);
        }
        console.log(`🗄️ Database Location: ${customDbPath}`);
        resolve({ totalProcessed, duration, dbPath: customDbPath });
      })
      .on('error', (err) => {
        db.close();
        console.error('❌ Error during CSV processing:', err);
        reject(err);
      });
  });
}

module.exports = buildDatabase;

// Support direct execution via CLI (e.g., node helpers/build-db.js)
if (require.main === module) {
  buildDatabase().catch((err) => {
    console.error('Fatal Pipeline Failure:', err);
    process.exit(1);
  });
}