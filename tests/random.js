/**
 * random.js
 * Migration script to add 'peribahasa_terkait' column safely.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'src', 'database', 'kamus-terbuka.db');

console.log(`🚀 Starting migration on: ${DB_PATH}`);

const db = new Database(DB_PATH, { verbose: console.log });

try {
    // 1. Get current columns
    const columns = db.prepare('PRAGMA table_info(entries)').all().map(c => c.name);

    // 2. Add the column if it doesn't exist
    if (!columns.includes('peribahasa_terkait')) {
        console.log('➕ Adding column: peribahasa_terkait');
        db.prepare('ALTER TABLE entries ADD COLUMN peribahasa_terkait TEXT').run();
        console.log('✅ Column added successfully.');
    } else {
        console.log('ℹ️ Column "peribahasa_terkait" already exists. Skipping.');
    }

    // 3. Optional: Add an index for performance if you plan to search this column often
    console.log('🔍 Creating index for peribahasa_terkait...');
    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_peribahasa_terkait ON entries(peribahasa_terkait)').run();

    // 4. Merge WAL and cleanup
    console.log('🧹 Finalizing: Merging WAL file...');
    db.pragma('wal_checkpoint(TRUNCATE)');
    
    console.log('🏁 Migration complete.');

} catch (err) {
    console.error('💥 Migration failed:', err.message);
} finally {
    db.close();
}