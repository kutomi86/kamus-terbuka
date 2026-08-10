/**
 * build-db-ai.js - Part 1: Configuration & CLI Commands
 * node helpers/enricher/build-db-ai.js
 * node helpers/enricher/build-db-ai.js merge
 * node helpers/enricher/build-db-ai.js reset
 */
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { processBatchWithAI } = require('../ai-engine/ai-provider');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');
const WORKER_ID = uuidv4().slice(0, 8); // Unique ID for this session
const STALE_THRESHOLD_MS = 180 * 1000; // 3 minutes
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ensures AI output is a flat string or null for SQLite compatibility.
 */
const sanitizeSqlValue = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
};

/**
 * Checks for active workers. If active, returns the time remaining until they are considered stale.
 */
function getMaintenanceLockInfo(db) {
  const latest = db.prepare("SELECT MAX(last_heartbeat) as last FROM worker_heartbeats").get();
  if (!latest || !latest.last) return { locked: false };

  const elapsed = Date.now() - latest.last;
  if (elapsed < STALE_THRESHOLD_MS) {
    const remainingSec = Math.ceil((STALE_THRESHOLD_MS - elapsed) / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    return { locked: true, timeStr: `${mins}m ${secs}s` };
  }
  return { locked: false };
}

/**
 * CLI Entry Point
 */
/**
 * build-db-ai.js - Fixed Part 1 (Main function update)
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'work';
  const dbPath = args[1] ? path.resolve(args[1]) : DEFAULT_DB_PATH;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // --- 1. GLOBAL SCHEMA INITIALIZATION (Moved here) ---
  // Ensure the heartbeat table exists
  db.prepare(`
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      last_heartbeat INTEGER
    )
  `).run();

  // Ensure the entries table has all necessary columns for AI work
  const columns = db.prepare("PRAGMA table_info(entries)").all().map(c => c.name);
  const requiredCols = ['jenis_entri', 'tags_bahasa', 'tags_kelas', 'tags_bidang', 'tags_ragam', 'ai_processed', 'worker_id'];
  
  for (const col of requiredCols) {
    if (!columns.includes(col)) {
      const def = col === 'ai_processed' ? ' INTEGER DEFAULT 0' : ' TEXT';
      db.prepare(`ALTER TABLE entries ADD COLUMN ${col}${def}`).run();
    }
  }
  
  // Ensure index exists for performance
  db.prepare("CREATE INDEX IF NOT EXISTS idx_worker_pending ON entries(ai_processed, worker_id)").run();

  // --- 2. COMMAND LOGIC ---
  if (command === 'merge' || command === 'reset') {
    const lock = getMaintenanceLockInfo(db);
    if (lock.locked) {
      console.error(`❌ Maintenance Rejected: Other workers are still active.`);
      console.error(`⏳ Please wait ${lock.timeStr} after stopping all workers before retrying.`);
      db.close();
      process.exit(1);
    }

    if (command === 'merge') {
      console.log('🧹 Maintenance: Merging WAL and shrinking database...');
      db.pragma('wal_checkpoint(TRUNCATE)');
      console.log('✅ Merge complete.');
      db.close();
      return;
    }

    if (command === 'reset') {
      console.log('♻️ Maintenance: Resetting worker claims and merging...');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.prepare("DELETE FROM worker_heartbeats").run();
      // This will now work because we ensured the column exists above!
      const info = db.prepare("UPDATE entries SET worker_id = NULL WHERE ai_processed = 0").run();
      console.log(`✅ Reset complete. ${info.changes} entries released.`);
      db.close();
      return;
    }
  }

  // Proceed to Worker Mode
  await runAiPipeline(db, dbPath);
}

// Proceeding to Part 2 logic definition...

/**
 * build-db-ai.js - Part 2: Worker Initialization & Chunk Management
 */

async function runAiPipeline(db, dbPath) {
  const batchSize = 30; // Optimal for Llama-3/Groq/SambaNova
  const chunkToClaim = 5000; 

  console.log(`🐝 Worker [${WORKER_ID}] started on ${dbPath}`);

  // 1. Schema & Column Safeguards (moved to main for global initialization)

  // 2. Heartbeat Management Functions
  const updateHeartbeat = () => {
    db.prepare("INSERT OR REPLACE INTO worker_heartbeats (worker_id, last_heartbeat) VALUES (?, ?)")
      .run(WORKER_ID, Date.now());
  };

  const removeHeartbeat = () => {
    db.prepare("DELETE FROM worker_heartbeats WHERE worker_id = ?").run(WORKER_ID);
  };

  // Initial registration
  updateHeartbeat();

  // 3. Prepared Statements
  const claimChunk = db.transaction(() => {
    // Look for entries not processed and not claimed
    const available = db.prepare(`
      SELECT id FROM entries 
      WHERE ai_processed = 0 AND worker_id IS NULL 
      LIMIT ?
    `).all(chunkToClaim);

    if (available.length === 0) return [];

    const ids = available.map(row => row.id);
    const claimStmt = db.prepare(`UPDATE entries SET worker_id = ? WHERE id = ?`);
    for (const id of ids) {
      claimStmt.run(WORKER_ID, id);
    }
    return ids;
  });

  const fetchClaimedBatch = db.prepare(`
    SELECT id, kata, lema, makna, etimologi, tags_bahasa, tags_kelas, tags_bidang, tags_ragam 
    FROM entries 
    WHERE worker_id = ? AND ai_processed = 0
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

  // 4. The Atomic Save Transaction
  const saveBatch = db.transaction((aiResults, originalRowsMap) => {
    const VALID_JENIS = new Set(['kata', 'frasa', 'peribahasa', 'lainnya']);
    const stats = { jenis: 0, bahasa: 0, kelas: 0, bidang: 0, ragam: 0 };

    for (const res of aiResults) {
      const original = originalRowsMap.get(res.id);
      if (!original) continue;

      const cleanBahasa = sanitizeSqlValue(res.tags_bahasa);
      const cleanKelas = sanitizeSqlValue(res.tags_kelas);
      const cleanBidang = sanitizeSqlValue(res.tags_bidang);
      const cleanRagam = sanitizeSqlValue(res.tags_ragam);

      let finalJenis = res.jenis_entri;
      if (!VALID_JENIS.has(finalJenis)) {
        const isSingleWord = original.kata && !original.kata.trim().includes(' ');
        finalJenis = isSingleWord ? 'kata' : 'lainnya';
      }
      stats.jenis++;

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

  // Proceed to Part 3 for the Execution Loop and Cleanup logic...

  /**
 * build-db-ai.js - Part 3: Main Execution Loop & Cleanup (Updated with Yellow Logging)
 */

  // 5. Execution Loop
  let totalSessionProcessed = 0;
  let sinceLastCheckpoint = 0;

  // Graceful exit handler: Remove heartbeat if the user presses Ctrl+C
  const cleanup = () => {
    console.log(`\n🛑 [${WORKER_ID}] Shutting down gracefully...`);
    try {
      removeHeartbeat();
      db.close();
    } catch (e) { /* ignore */ }
    process.exit();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  while (true) {
    const claimedIds = claimChunk();
    if (claimedIds.length === 0) {
      console.log(`🏁 [${WORKER_ID}] No more unoccupied rows. Task complete!`);
      break;
    }

    const startId = claimedIds[0];
    const endId = claimedIds[claimedIds.length - 1];
    const chunkRangeStr = `[${startId} - ${endId}]`; // Define range once for the whole chunk
    
    console.log(`\n💎 [${WORKER_ID}] Claimed Chunk: IDs ${chunkRangeStr}`);

    let chunkProcessed = 0;
    while (chunkProcessed < claimedIds.length) {
      const rows = fetchClaimedBatch.all(WORKER_ID, batchSize);
      if (rows.length === 0) break;

      try {
        const originalRowsMap = new Map(rows.map(r => [r.id, r]));
        
        // Request AI processing (use prompt from helpers/datasets/system_prompt.txt by default)
        const aiResults = await processBatchWithAI(rows, { promptPath: path.join(__dirname, 'datasets', 'system_prompt.txt') });
        
        // Save results and update stats
        const stats = saveBatch(aiResults, originalRowsMap);

        chunkProcessed += rows.length;
        totalSessionProcessed += rows.length;
        sinceLastCheckpoint += rows.length;

        // CRITICAL: Update heartbeat so other sessions know we are still alive
        updateHeartbeat();

        // Standard progress log
        console.log(`   ✅ [${chunkProcessed}/${claimedIds.length}] (Jenis: ${stats.jenis} | Improvements: ${stats.bahasa + stats.kelas + stats.bidang + stats.ragam})`);
        
        // YELLOW CHUNK LOGGING (\x1b[33m is Yellow, \x1b[0m is Reset)
        console.log(`\x1b[33m   💼 Chunk: ${chunkRangeStr}\x1b[0m`);

        // Periodic Checkpoint (Passive) to keep performance high
        if (sinceLastCheckpoint >= 1000) {
          console.log(`   🧹 [${WORKER_ID}] Checkpoint: Merging WAL...`);
          db.pragma('wal_checkpoint(PASSIVE)');
          sinceLastCheckpoint = 0;
        }

      } catch (err) {
        console.error(`   ❌ [${WORKER_ID}] Batch error: ${err.message}. Retrying in 10s...`);
        // Refresh heartbeat even on failure so we don't get timed out while waiting
        updateHeartbeat();
        await sleep(10000);
      }
    }
    
    console.log(`✅ [${WORKER_ID}] Chunk ${chunkRangeStr} finished.`);
  }

  // Cleanup if loop finishes normally
  removeHeartbeat();
  db.close();
  return totalSessionProcessed;
}

// --- START THE SCRIPT ---
main().catch(err => {
  console.error('\n💥 Fatal Execution Error:', err);
  process.exit(1);
});