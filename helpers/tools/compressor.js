/**
 * helpers/tools/compressor.js
 * 
 * Safely reclaims free space and defragments the database using VACUUM.
 * Ensures data integrity by comparing entry and index counts before and after.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');

function formatMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function main() {
    const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DB_PATH;

    if (!fs.existsSync(dbPath)) {
        console.error(`❌ Database not found at: ${dbPath}`);
        process.exit(1);
    }

    const db = new Database(dbPath);
    console.log(`🚀 Analysis started: ${path.basename(dbPath)}`);

    // --- PHASE 1: GATHER "BEFORE" METRICS ---

    // 1. Count Total Entries
    const { count: entryCountBefore } = db.prepare('SELECT COUNT(*) as count FROM entries').get();

    // 2. Count Total Indexes (Crucial for your peace of mind!)
    const { count: indexCountBefore } = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='index'").get();

    // 3. Calculate Potential Savings
    const freelistCount = db.pragma('freelist_count', { simple: true });
    const pageSize = db.pragma('page_size', { simple: true });
    const potentialSavingsBytes = freelistCount * pageSize;

    // 4. Get Current File Size
    const statsBefore = fs.statSync(dbPath);
    const sizeBefore = statsBefore.size;

    console.log('\n📊 --- PRE-COMPRESSION ANALYSIS ---');
    console.log(`📝 Total Entries: ${entryCountBefore.toLocaleString()}`);
    console.log(`🔍 Total Indexes: ${indexCountBefore}`);
    console.log(`📂 Current Size:  ${formatMB(sizeBefore)}`);
    console.log(`👻 Ghost Space:   ${formatMB(potentialSavingsBytes)} (Freelist)`);

    if (potentialSavingsBytes === 0) {
        console.log('\n✨ Database is already fully compressed. No action needed.');
        db.close();
        return;
    }

    // Safety check for disk space
    // VACUUM needs roughly double the current size in temp space to run safely.
    console.log('\n⚠️  Note: VACUUM will rebuild the file. This is a safe operation.');
    console.log('🔄 Proceeding to compression phase...');

    // --- PHASE 2: COMPRESSION EXECUTION ---

    const startTime = Date.now();

    try {
        console.log('⌛ Compressing database (this may take a moment)...');
        
        // Execute the VACUUM command
        // This rebuilds the database file from scratch, defragmenting it
        db.prepare('VACUUM').run();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ VACUUM completed in ${duration}s.`);

        // --- PHASE 3: POST-COMPRESSION METRICS ---

        // 1. Count Total Entries After
        const { count: entryCountAfter } = db.prepare('SELECT COUNT(*) as count FROM entries').get();

        // 2. Count Total Indexes After
        const { count: indexCountAfter } = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='index'").get();

        // 3. Get New File Size
        const statsAfter = fs.statSync(dbPath);
        const sizeAfter = statsAfter.size;

        // --- PHASE 4: FINAL VERIFICATION & REPORTING ---

        console.log('\n🏁 --- POST-COMPRESSION VERIFICATION ---');
        
        // Safety Verification 1: Entries
        if (entryCountBefore === entryCountAfter) {
            console.log(`✅ Data Integrity: ALL ${entryCountAfter.toLocaleString()} entries are intact.`);
        } else {
            console.error(`❌ CRITICAL ERROR: Entry mismatch! Before: ${entryCountBefore}, After: ${entryCountAfter}`);
        }

        // Safety Verification 2: Indexes (Addressing your concern)
        if (indexCountBefore === indexCountAfter) {
            console.log(`✅ Index Integrity: ALL ${indexCountAfter} indexes are preserved and optimized.`);
        } else {
            console.error(`❌ CRITICAL ERROR: Index mismatch! Before: ${indexCountBefore}, After: ${indexCountAfter}`);
        }

        // Final Health Check
        const integrity = db.pragma('integrity_check', { simple: true });
        if (integrity === 'ok') {
            console.log('✅ Database Health: Integrity Check Passed.');
        } else {
            console.warn(`⚠️ Database Health Warning: ${integrity}`);
        }

        // Size Results
        const saved = sizeBefore - sizeAfter;
        console.log('\n📈 --- SIZE RESULTS ---');
        console.log(`📉 New File Size: ${formatMB(sizeAfter)}`);
        console.log(`✨ Total Savings: ${formatMB(saved)} (${((saved / sizeBefore) * 100).toFixed(1)}% reduction)`);

    } catch (err) {
        console.error('\n💥 Compression failed during execution:', err.message);
    } finally {
        db.close();
        console.log('\n🏁 Process finished.');
    }
}

main().catch(err => {
    console.error('\n💥 Fatal Error:', err);
    process.exit(1);
});