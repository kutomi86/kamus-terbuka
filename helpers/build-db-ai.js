// --- ADD THIS HELPER AT THE TOP OF build-db-ai.js (outside the function) ---
/**
 * Ensures AI output is a flat string or null for SQLite compatibility.
 * Handles cases where AI might return an Array or an Object.
 */
const sanitizeSqlValue = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (Array.isArray(val)) return val.join(', '); // Convert ["Arab", "Persia"] -> "Arab, Persia"
  if (typeof val === 'object') return JSON.stringify(val); // Last resort for unexpected objects
  return String(val);
};



/**
 * build-db-ai.js - Part 1: Setup & Transaction Logic
 */
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { processBatchWithAI } = require('./ai-provider');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'src', 'database', 'kamus-terbuka.db');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAiPipeline(dbPath = DEFAULT_DB_PATH, options = {}) {
  const batchSize = options.batchSize || 20;
  const maxLimit = options.limit || 0;

  console.log(`🗄️ Target Database: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 1. Column Safeguard
  const columns = db.prepare("PRAGMA table_info(entries)").all();
  const columnNames = columns.map((c) => c.name);
  const requiredColumns = ['jenis_entri', 'tags_bahasa', 'tags_kelas', 'tags_bidang', 'tags_ragam', 'ai_processed'];

  for (const col of requiredColumns) {
    if (!columnNames.includes(col)) {
      const defaultClause = col === 'ai_processed' ? ' INTEGER DEFAULT 0' : ' TEXT';
      db.prepare(`ALTER TABLE entries ADD COLUMN ${col}${defaultClause}`).run();
    }
  }

  // 2. Prepared Statements
  const fetchStmt = db.prepare(`
    SELECT id, kata, lema, makna, etimologi, tags_bahasa, tags_kelas, tags_bidang, tags_ragam 
    FROM entries 
    WHERE ai_processed = 0 
    ORDER BY id ASC
    LIMIT ?
  `);

  const updateStmt = db.prepare(`
    UPDATE entries 
    SET jenis_entri = @jenis_entri,
        tags_bahasa = @tags_bahasa,
        tags_kelas = @tags_kelas,
        tags_bidang = @tags_bidang,
        tags_ragam = @tags_ragam,
        ai_processed = 1
    WHERE id = @id
  `);

  // 3. The Atomic Transaction with Fallback & Differential Stats
  // --- UPDATE THE saveBatch TRANSACTION BLOCK ---
  const saveBatch = db.transaction((aiResults, originalRowsMap) => {
    const VALID_JENIS = new Set(['kata', 'frasa', 'peribahasa', 'lainnya']);
    const stats = { jenis: 0, bahasa: 0, kelas: 0, bidang: 0, ragam: 0 };

    for (const res of aiResults) {
      const original = originalRowsMap.get(res.id);
      if (!original) continue;

      // 1. Sanitize all incoming AI values immediately
      const cleanBahasa = sanitizeSqlValue(res.tags_bahasa);
      const cleanKelas = sanitizeSqlValue(res.tags_kelas);
      const cleanBidang = sanitizeSqlValue(res.tags_bidang);
      const cleanRagam = sanitizeSqlValue(res.tags_ragam);

      // 2. Fallback Logic for jenis_entri
      let finalJenis = res.jenis_entri;
      if (!VALID_JENIS.has(finalJenis)) {
        const isSingleWord = original.kata && !original.kata.trim().includes(' ');
        finalJenis = isSingleWord ? 'kata' : 'lainnya';
      }
      stats.jenis++;

      // 3. Stats checking (Compare sanitized versions)
      if (cleanBahasa && cleanBahasa !== original.tags_bahasa) stats.bahasa++;
      if (cleanKelas && cleanKelas !== original.tags_kelas) stats.kelas++;
      if (cleanBidang && cleanBidang !== original.tags_bidang) stats.bidang++;
      if (cleanRagam && cleanRagam !== original.tags_ragam) stats.ragam++;

      updateStmt.run({
        id: res.id,
        jenis_entri: finalJenis,
        tags_bahasa: cleanBahasa || original.tags_bahasa,
        tags_kelas: cleanKelas || original.tags_kelas,
        tags_bidang: cleanBidang || original.tags_bidang,
        tags_ragam: cleanRagam || original.tags_ragam,
      });
    }
    return stats;
  });

  // [Execution Loop Logic continues in Part 2]

  /**
 * build-db-ai.js - Part 2: Execution Loop & Detailed Logging
 */

  let totalProcessed = 0;
  console.log(`🚀 Starting AI Processing Pipeline (Batch size: ${batchSize})`);

  // 4. Execution Loop
  while (true) {
    if (maxLimit > 0 && totalProcessed >= maxLimit) {
      console.log(`🎯 Reached target limit of ${maxLimit} entries.`);
      break;
    }

    const currentBatchSize = maxLimit > 0 
      ? Math.min(batchSize, maxLimit - totalProcessed) 
      : batchSize;
      
    const rows = fetchStmt.all(currentBatchSize);

    if (rows.length === 0) {
      console.log('✅ No more unprocessed rows found. Processing complete!');
      break;
    }

    // Capture the range for logging and map data for comparison
    const originalRowsMap = new Map(rows.map(row => [row.id, row]));
    const minId = rows[0].id;
    const maxId = rows[rows.length - 1].id;

    try {
      // Call the AI provider (with rotating logic defined in ai-provider.js)
      const aiResults = await processBatchWithAI(rows);

      if (!Array.isArray(aiResults)) {
        throw new Error('AI provider did not return an array of results.');
      }

      // Execute the atomic transaction (from Part 1)
      const stats = saveBatch(aiResults, originalRowsMap);

      totalProcessed += rows.length;

      // --- DETAILED LOGGING ---
      console.log(`\n📦 Batch IDs: ${minId} - ${maxId} (Processed this session: ${totalProcessed})`);
      
      // Mandatory logging: jenis_entri
      console.log(`   ✔️ ${stats.jenis}/${rows.length} jenis_entri assigned.`);

      // Conditional differential logging (only if changes were made)
      const changes = [];
      if (stats.bahasa > 0) changes.push(`${stats.bahasa} tags_bahasa enriched`);
      if (stats.kelas > 0) changes.push(`${stats.kelas} tags_kelas inferred`);
      if (stats.bidang > 0) changes.push(`${stats.bidang} tags_bidang identified`);
      if (stats.ragam > 0) changes.push(`${stats.ragam} tags_ragam updated`);

      if (changes.length > 0) {
        console.log(`   ✨ Improvements: ${changes.join(', ')}`);
      }

    } catch (err) {
      console.error(`❌ Batch [${minId}-${maxId}] failed: ${err.message}`);
      console.log('⏳ Waiting 10 seconds before retrying current batch...');
      await sleep(10000);
    }
  }

  db.close();
  return totalProcessed;
}

/**
 * 5. CLI Execution & Export
 */
if (require.main === module) {
  const customDbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH;
  runAiPipeline(customDbPath)
    .then((count) => console.log(`\n🎉 Task finished. Processed ${count} total records.`))
    .catch((err) => {
      console.error('\n💥 Fatal error:', err);
      process.exit(1);
    });
}

module.exports = {
  runAiPipeline,
};