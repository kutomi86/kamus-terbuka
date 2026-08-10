/**
 * helpers/enricher/relation-builder.js
 *
 * Runs locally to build relationships (turunan, gabungan_kata, terkait)
 * for all dictionary entries using fast in-memory indexing.
 *
 * Usage:
 *   node helpers/enricher/relation-builder.js
 *   node helpers/enricher/relation-builder.js --dry-run
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');

function ensureSchema(db) {
    db.pragma('journal_mode = WAL');

    const columns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
    
    const requiredCols = [
        { name: 'terkait', def: ' TEXT' },
        { name: 'bahasa_gaul', def: ' INTEGER DEFAULT 0' }
    ];

    for (const col of requiredCols) {
        if (!columns.includes(col.name)) {
            db.prepare(`ALTER TABLE entries ADD COLUMN ${col.name}${col.def}`).run();
            console.log(`📡 Added column: ${col.name}`);
        }
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_dasar ON entries(dasar)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_terkait ON entries(terkait)').run();
}

function getPrefixStripRoot(kata, wordMap) {
    if (typeof kata !== 'string' || kata.includes(' ')) return null;

    const prefixes = [
        /^ber(.*?)$/, /^be(.*?)$/, /^bel(.*?)$/,
        /^meng(.*?)$/, /^meny(.*?)$/, /^men(.*?)$/, /^mem(.*?)$/, /^me(.*?)$/,
        /^di(.*?)$/,
        /^ter(.*?)$/, /^te(.*?)$/,
        /^peng(.*?)$/, /^peny(.*?)$/, /^pen(.*?)$/, /^pem(.*?)$/, /^per(.*?)$/, /^pe(.*?)$/,
        /^se(.*?)$/,
        /^ke(.*?)$/
    ];

    for (const regex of prefixes) {
        const match = kata.match(regex);
        if (match && match[1]) {
            const stem = match[1];
            if (wordMap.has(stem)) {
                return stem;
            }
        }
    }
    return null;
}

function cleanAndSplitPipe(str) {
    if (!str) return [];
    return str.split('|').map(x => x.trim()).filter(Boolean);
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const dbPath = args[0] && !args[0].startsWith('-') ? path.resolve(args[0]) : DEFAULT_DB_PATH;

    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database not found at ${dbPath}`);
    }

    console.log(`🔗 Relation Builder started on database: ${dbPath}`);
    if (dryRun) {
        console.log('🧪 Running in DRY-RUN mode. No changes will be written to the database.');
    }

    const db = new Database(dbPath);
    ensureSchema(db);

    console.log('📖 Fetching entries from database...');
    const rows = db.prepare('SELECT id, kata, dasar, jenis_entri, turunan, gabungan_kata FROM entries').all();
    console.log(`📊 Loaded ${rows.length.toLocaleString()} entries.`);

    // Step 1: Build fast lookup maps
    const wordMap = new Map();
    const dasarMap = new Map();
    const phraseMap = new Map();

    for (const row of rows) {
        wordMap.set(row.kata, row);
    }

    console.log('🧠 Building in-memory relationship indices...');
    for (const row of rows) {
        // 1. Map explicit base word (dasar)
        let root = row.dasar;
        if (!root) {
            // Fallback: Check if word prefix maps to a known root word
            root = getPrefixStripRoot(row.kata, wordMap);
        }

        if (root && root !== row.kata) {
            if (!dasarMap.has(root)) {
                dasarMap.set(root, []);
            }
            dasarMap.get(root).push(row);
        }

        // 2. Map phrases containing this word
        if (row.kata.includes(' ')) {
            const words = row.kata.split(/[\s-]+/).map(w => w.trim().toLowerCase()).filter(Boolean);
            for (const w of words) {
                if (!phraseMap.has(w)) {
                    phraseMap.set(w, []);
                }
                phraseMap.get(w).push(row.kata);
            }
        }
    }

    console.log('🧬 Scanning and associating related words...');
    const updates = [];
    let processedCount = 0;

    for (const row of rows) {
        const W = row.kata;
        const turunanSet = new Set(cleanAndSplitPipe(row.turunan));
        const gabunganSet = new Set(cleanAndSplitPipe(row.gabungan_kata));

        // 1. Add derivatives from dasarMap
        const derivatives = dasarMap.get(W);
        if (derivatives) {
            for (const rel of derivatives) {
                if (rel.kata === W) continue;
                if (rel.kata.includes(' ') || rel.jenis_entri === 'frasa') {
                    gabunganSet.add(rel.kata);
                } else {
                    turunanSet.add(rel.kata);
                }
            }
        }

        // 2. Add phrases containing this word from phraseMap
        const lowercaseW = W.toLowerCase();
        const phrases = phraseMap.get(lowercaseW);
        if (phrases) {
            for (const phrase of phrases) {
                if (phrase === W) continue;
                gabunganSet.add(phrase);
            }
        }

        // Exclude self and format outputs
        const cleanTurunanList = [...turunanSet].filter(x => x !== W);
        const cleanGabunganList = [...gabunganSet].filter(x => x !== W);
        const terkaitList = [...new Set([...cleanTurunanList, ...cleanGabunganList])];

        const finalTurunan = cleanTurunanList.join(' | ') || null;
        const finalGabungan = cleanGabunganList.join(' | ') || null;
        const finalTerkait = terkaitList.join(' | ') || null;

        const originalTurunan = row.turunan || null;
        const originalGabungan = row.gabungan_kata || null;

        // Verify if changes were made
        if (finalTurunan !== originalTurunan || finalGabungan !== originalGabungan || finalTerkait !== null) {
            updates.push({
                id: row.id,
                kata: W,
                turunan: finalTurunan,
                gabungan_kata: finalGabungan,
                terkait: finalTerkait
            });
        }

        processedCount++;
        if (processedCount % 50000 === 0) {
            console.log(`   Processed ${processedCount.toLocaleString()} / ${rows.length.toLocaleString()}...`);
        }
    }

    console.log(`✨ Found ${updates.length.toLocaleString()} entries needing relationship updates.`);

    if (dryRun) {
        console.log('\n🔍 Sample dry-run updates:');
        const samples = updates.slice(0, 10);
        samples.forEach((up, idx) => {
            console.log(`${idx + 1}. ${up.kata} (ID: ${up.id}):`);
            console.log(`   - Turunan: ${up.turunan}`);
            console.log(`   - Gabungan: ${up.gabungan_kata}`);
            console.log(`   - Terkait: ${up.terkait}`);
        });
    } else if (updates.length > 0) {
        console.log('💾 Writing updates to database...');
        const updateStmt = db.prepare(`
            UPDATE entries
            SET turunan = ?,
                gabungan_kata = ?,
                terkait = ?
            WHERE id = ?
        `);

        const executeTransaction = db.transaction((items) => {
            for (const item of items) {
                updateStmt.run(item.turunan, item.gabungan_kata, item.terkait, item.id);
            }
        });

        const startTime = Date.now();
        executeTransaction(updates);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ Successfully updated ${updates.length.toLocaleString()} entries in ${duration}s!`);
    } else {
        console.log('✅ No relationship updates needed.');
    }

    db.pragma('wal_checkpoint(PASSIVE)');
    db.close();
    console.log('🏁 Relation Builder complete.');
}

main().catch(err => {
    console.error('\n💥 Relation Builder Error:', err);
    process.exit(1);
});
