require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { processBatchWithAI } = require('./ai-provider');

// Default target path matching project structure: src/database/kamus-terbuka.db
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'src', 'database', 'kamus-terbuka.db');

/**
 * Helper to pause execution for a given duration in milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Main batch runner process.
 * 
 * @param {string} dbPath - Path to SQLite database file
 * @param {Object} options - Configuration options
 * @param {number} options.batchSize - Number of rows per AI call (default: 20)
 * @param {number} options.limit - Max total rows to process in this run (0 for unlimited)
 */
async function runAiPipeline(dbPath = DEFAULT_DB_PATH, options = {}) {
  const batchSize = options.batchSize || 20;
  const maxLimit = options.limit || 0;

  console.log(`🗄️ Target Database: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 1. Safeguard: Ensure all target enrichment columns exist on the table
  const columns = db.prepare("PRAGMA table_info(entries)").all();
  const columnNames = columns.map((c) => c.name);

  const requiredColumns = [
    'jenis_entri',
    'tags_bahasa',
    'tags_kelas',
    'tags_bidang',
    'tags_ragam',
    'ai_processed'
  ];

  for (const col of requiredColumns) {
    if (!columnNames.includes(col)) {
      const defaultClause = col === 'ai_processed' ? ' INTEGER DEFAULT 0' : ' TEXT';
      db.prepare(`ALTER TABLE entries ADD COLUMN ${col}${defaultClause}`).run();
    }
  }

  // 2. SQL Statements
  // Fetch unprocessed rows along with fields required for AI lexical context
  const fetchStmt = db.prepare(`
    SELECT id, kata, lema, makna, etimologi, tags_bahasa, tags_kelas, tags_bidang, tags_ragam, peribahasa, gabungan_kata 
    FROM entries 
    WHERE ai_processed = 0 
    LIMIT ?
  `);

  // Non-destructive update preserving existing values via COALESCE
  const updateStmt = db.prepare(`
    UPDATE entries 
    SET jenis_entri = @jenis_entri,
        tags_bahasa = COALESCE(@tags_bahasa, tags_bahasa),
        tags_kelas = COALESCE(@tags_kelas, tags_kelas),
        tags_bidang = COALESCE(@tags_bidang, tags_bidang),
        tags_ragam = COALESCE(@tags_ragam, tags_ragam),
        ai_processed = 1
    WHERE id = @id
  `);

  // Atomic batch commit logic
  const saveTransaction = db.transaction((results) => {
    // Valid categories check
    const VALID_JENIS = new Set(['kata', 'frasa', 'peribahasa', 'lainnya']);

    const saveTransaction = db.transaction((results) => {
        for (const res of results) {
            // Default to 'lainnya' if null, undefined, or invalid
            const jenisEntri = VALID_JENIS.has(res.jenis_entri) ? res.jenis_entri : 'lainnya';

            updateStmt.run({
                id: res.id,
                jenis_entri: jenisEntri,
                tags_bahasa: res.tags_bahasa || null,
                tags_kelas: res.tags_kelas || null,
                tags_bidang: res.tags_bidang || null,
                tags_ragam: res.tags_ragam || null,
            });
        }
    });
  });

  let totalProcessed = 0;
  console.log(`🚀 Starting AI Processing Pipeline (Batch size: ${batchSize})`);

  // 3. Execution Loop
  while (true) {
    if (maxLimit > 0 && totalProcessed >= maxLimit) {
      console.log(`🎯 Reached target limit of ${maxLimit} entries.`);
      break;
    }

    const currentBatchSize = maxLimit > 0 ? Math.min(batchSize, maxLimit - totalProcessed) : batchSize;
    const rows = fetchStmt.all(currentBatchSize);

    if (rows.length === 0) {
      console.log('✅ No more unprocessed rows found. Processing complete!');
      break;
    }

    console.log(`📦 Processing batch of ${rows.length} rows (Processed so far: ${totalProcessed})...`);

    try {
      const aiResults = await processBatchWithAI(rows);

      if (!Array.isArray(aiResults)) {
        throw new Error('AI provider did not return an array of results.');
      }

      saveTransaction(aiResults);
      totalProcessed += rows.length;
      console.log(`✔️ Batch saved successfully. Total processed: ${totalProcessed}`);

    } catch (err) {
      console.error(`❌ Batch failed: ${err.message}`);
      console.log('⏳ Waiting 10 seconds before retrying current batch...');
      await sleep(10000);
    }
  }

  db.close();
  return totalProcessed;
}

module.exports = {
  runAiPipeline,
};

// Allow direct CLI execution: node helpers/build-db-ai.js
if (require.main === module) {
  const customDbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH;
  runAiPipeline(customDbPath)
    .then((count) => console.log(`🎉 Task finished. Processed ${count} total records.`))
    .catch((err) => console.error('💥 Fatal error:', err));
}