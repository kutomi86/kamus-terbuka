/**
 * helpers/enricher/expander.js
 * 
 * Final cleanup tool to expand abbreviations across semantic columns.
 * Updates both the database and the expansion_mapper.js statistics.
 * 
 * Usage:
 *   node helpers/enricher/expander.js
 *   node helpers/enricher/expander.js --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Load the mapper
const MAPPER_PATH = path.join(__dirname, '..', 'datasets', 'expansion_mapper.js');
let { expansions, stats } = require(MAPPER_PATH);

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');

/**
 * Creates a reverse lookup: Abbreviation -> Full Word
 */
const reverseMap = {};
for (const [full, abbrs] of Object.entries(expansions)) {
    for (const abbr of abbrs) {
        reverseMap[abbr.toLowerCase()] = full;
    }
}

/**
 * Helper to split pipe-separated strings
 */
function splitPipe(str) {
    if (!str) return [];
    return str.split('|').map(x => x.trim()).filter(Boolean);
}

/**
 * The core expansion engine
 */
function expandText(text, trackStats = true) {
    if (!text) return text;
    let expanded = text;

    // Iterate through all known abbreviations
    for (const [abbr, full] of Object.entries(reverseMap)) {
        // Escape special characters (like the '/' in 's/d')
        const escapedAbbr = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedAbbr}\\b`, 'gi');

        if (trackStats) {
            const matches = expanded.match(regex);
            if (matches) {
                stats[abbr] = (stats[abbr] || 0) + matches.length;
            }
        }

        // Replace while preserving case where possible
        expanded = expanded.replace(regex, (match) => {
            // If original was uppercase (e.g., "Yg"), capitalize full word
            if (match[0] === match[0].toUpperCase()) {
                return full.charAt(0).toUpperCase() + full.slice(1);
            }
            return full;
        });
    }
    return expanded;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const dbPath = args[0] && !args[0].startsWith('-') ? path.resolve(args[0]) : DEFAULT_DB_PATH;

    console.log(`Expansion started on: ${dbPath} ${dryRun ? '[DRY RUN]' : ''}`);

    const db = new Database(dbPath);
    const rows = db.prepare(`
        SELECT id, kata, jenis_entri, makna, contoh, peribahasa, terkait, peribahasa_terkait, turunan, gabungan_kata 
        FROM entries
    `).all();

    const updates = [];

    for (const row of rows) {
        let changed = false;

        // 1. Standard Fields
        const newMakna = expandText(row.makna);
        const newContoh = expandText(row.contoh);
        const newPeribahasa = expandText(row.peribahasa);
        const newPeribahasaTerkait = expandText(row.peribahasa_terkait);

        // 2. Conditional Field: kata (only if peribahasa)
        let newKata = row.kata;
        if (row.jenis_entri === 'peribahasa') {
            newKata = expandText(row.kata);
        }

        // 3. Conditional Field: terkait (Protection Logic)
        const protection = new Set([
            ...splitPipe(row.turunan),
            ...splitPipe(row.gabungan_kata)
        ]);

        const terkaitWords = splitPipe(row.terkait);
        const newTerkaitWords = terkaitWords.map(word => {
            if (protection.has(word)) return word;
            return expandText(word);
        });
        const newTerkait = newTerkaitWords.join(' | ') || null;

        // Check for changes
        if (
            newMakna !== row.makna ||
            newContoh !== row.contoh ||
            newPeribahasa !== row.peribahasa ||
            newPeribahasaTerkait !== row.peribahasa_terkait ||
            newKata !== row.kata ||
            newTerkait !== row.terkait
        ) {
            updates.push({
                id: row.id,
                makna: newMakna,
                contoh: newContoh,
                peribahasa: newPeribahasa,
                peribahasa_terkait: newPeribahasaTerkait,
                kata: newKata,
                terkait: newTerkait
            });
        }
    }

    console.log(`✨ Found ${updates.length.toLocaleString()} entries to expand.`);

    if (!dryRun && updates.length > 0) {
        console.log('💾 Updating database...');
        const stmt = db.prepare(`
            UPDATE entries SET 
                makna = ?, contoh = ?, peribahasa = ?, peribahasa_terkait = ?, kata = ?, terkait = ? 
            WHERE id = ?
        `);

        db.transaction((items) => {
            for (const item of items) {
                stmt.run(item.makna, item.contoh, item.peribahasa, item.peribahasa_terkait, item.kata, item.terkait, item.id);
            }
        })(updates);

        // Rewrite the expansion_mapper.js with updated stats
        console.log('📊 Updating expansion_mapper.js statistics...');
        const mapperContent = `/**
 * expansion_mapper.js
 * 
 * Centralized mapping for Indonesian abbreviation expansion.
 * Auto-generated by expander.js
 */

const expansions = ${JSON.stringify(expansions, null, 4)};

const stats = ${JSON.stringify(stats, null, 4)};

module.exports = { expansions, stats };
`;
        fs.writeFileSync(MAPPER_PATH, mapperContent, 'utf8');
        
        db.pragma('wal_checkpoint(PASSIVE)');
    } else if (dryRun) {
        console.log('🧪 Dry-run samples:');
        updates.slice(0, 5).forEach(u => console.log(`- ID ${u.id}: ${u.kata}`));
    }

    db.close();
    console.log('🏁 Expansion complete.');
}

main().catch(console.error);