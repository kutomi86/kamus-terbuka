const Database = require('better-sqlite3');
const path = require('path');

// Use path.join to resolve relative to this script directory
const db = new Database(path.join(__dirname, '../src/database/kamus-terbuka.db'));

// Run everything in a single transaction for safety and speed
const reorderDatabase = db.transaction(() => {
    console.log("Renaming old table...");
    db.prepare(`ALTER TABLE entries RENAME TO entries_old`).run();

    console.log("Creating new table schema (excluding ai_processed and worker_id)...");
    db.prepare(`
        CREATE TABLE entries (
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
            dasar TEXT,
            jenis_entri TEXT,
            enriched INTEGER DEFAULT 0,
            enriched_worker_id TEXT,
            enriched_claim_expires_at INTEGER,
            enriched_at INTEGER
        )
    `).run();

    console.log("Inserting sorted data... This might take a moment.");
    db.prepare(`
        INSERT INTO entries (
            kata, lema, pelafalan, etimologi, makna, tags_kelas, 
            tags_bahasa, tags_bidang, tags_ragam, tags_sumber, 
            contoh, turunan, gabungan_kata, peribahasa, kiasan, 
            varian, dasar, jenis_entri, enriched, 
            enriched_worker_id, enriched_claim_expires_at, enriched_at
        )
        SELECT 
            kata, lema, pelafalan, etimologi, makna, tags_kelas, 
            tags_bahasa, tags_bidang, tags_ragam, tags_sumber, 
            contoh, turunan, gabungan_kata, peribahasa, kiasan, 
            varian, dasar, jenis_entri, enriched, 
            enriched_worker_id, enriched_claim_expires_at, enriched_at
        FROM entries_old 
        ORDER BY kata ASC
    `).run();

    console.log("Cleaning up...");
    db.prepare(`DROP TABLE entries_old`).run();

    console.log("Recreating indexes...");
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_kata ON entries(kata)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_lema ON entries(lema)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_enriched ON entries(enriched, enriched_worker_id)`).run();
    
    // Optional: Reset the sequence counter to match the new count
    db.prepare(`UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM entries) WHERE name = 'entries'`).run();

    console.log("Success! Table reordered and columns excluded.");
});

// Execute the transaction
try {
    reorderDatabase();
} catch (err) {
    console.error("Transaction failed! Database remains unchanged.", err);
}
