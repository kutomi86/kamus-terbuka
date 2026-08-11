/**
 * helpers/enricher/relation-builder.js
 *
 * Runs locally to build relationships (turunan, gabungan_kata, terkait, peribahasa_terkait)
 * for all dictionary entries using fast in-memory indexing.
 *
 * Final Refinements:
 * - Universal Proverb Sync: Ensures 'peribahasa' and 'peribahasa_terkait' match for all entries.
 * - Derivative Proverb Discovery: Derivatives now pull proverbs associated with their roots.
 * - Abbreviation Expansion: "dp", "yg", etc., are expanded before comparison.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');

/**
 * Expands common Indonesian abbreviations found in proverbs
 */
function expandAbbreviations(text) {
    if (!text) return null;
    const map = {
        'dp': 'daripada',
        'yg': 'yang',
        'dlm': 'dalam',
        'tsb': 'tersebut',
        'dng': 'dengan',
        'kpd': 'kepada',
        'sdh': 'sudah',
        'blm': 'belum'
    };
    
    let expanded = text;
    for (const [abbr, full] of Object.entries(map)) {
        const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
        expanded = expanded.replace(regex, full);
    }
    return expanded;
}

function ensureSchema(db, dryRun = false) {
    if (dryRun) return;
    
    db.pragma('journal_mode = WAL');
    const columns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
    
    const requiredCols = [
        { name: 'terkait', def: ' TEXT' },
        { name: 'peribahasa_terkait', def: ' TEXT' },
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

/**
 * Enhanced Stripper: Prioritizes prefixes to avoid "dicari" -> "car" errors.
 */
function getAffixStripRoot(kata, wordMap) {
    if (typeof kata !== 'string' || kata.includes(' ')) return null;
    if (kata.length <= 3) return null;

    const prefixes = [
        /^ber(.*?)$/, /^bel(.*?)$/, /^be(.*?)$/,
        /^meng(.*?)$/, /^meny(.*?)$/, /^men(.*?)$/, /^mem(.*?)$/, /^me(.*?)$/,
        /^di(.*?)$/, /^ter(.*?)$/, /^te(.*?)$/,
        /^peng(.*?)$/, /^peny(.*?)$/, /^pen(.*?)$/, /^pem(.*?)$/, /^per(.*?)$/, /^pe(.*?)$/,
        /^se(.*?)$/, /^ke(.*?)$/
    ];

    const suffixes = [/(.*?)nya$/, /(.*?)kan$/, /(.*?)an$/, /(.*?)i$/, /(.*?)lah$/, /(.*?)kah$/];

    for (const regex of prefixes) {
        const match = kata.match(regex);
        if (match && match[1]) {
            const stem = match[1];
            if (wordMap.has(stem)) return stem;
            for (const sRegex of suffixes) {
                const sMatch = stem.match(sRegex);
                if (sMatch && sMatch[1] && wordMap.has(sMatch[1])) return sMatch[1];
            }
        }
    }

    for (const regex of suffixes) {
        const match = kata.match(regex);
        if (match && match[1]) {
            const stem = match[1];
            if (wordMap.has(stem)) return stem;
        }
    }
    
    return null;
}

function cleanAndSplitPipe(str) {
    if (!str) return [];
    return str.split('|').map(x => x.trim()).filter(Boolean);
}

function getConstituentRoots(text, wordMap) {
    if (!text) return [];
    const expanded = expandAbbreviations(text);
    const tokens = expanded.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    const roots = new Set();
    for (const token of tokens) {
        if (wordMap.has(token)) {
            roots.add(token);
        } else {
            const root = getAffixStripRoot(token, wordMap);
            if (root) roots.add(root);
        }
    }
    return [...roots];
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const dbPath = args[0] && !args[0].startsWith('-') ? path.resolve(args[0]) : DEFAULT_DB_PATH;

    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database not found at ${dbPath}`);
    }

    console.log(`🔗 Relation Builder started on database: ${dbPath}`);
    const db = new Database(dbPath);
    ensureSchema(db, dryRun);

    console.log('📖 Fetching entries from database...');
    const rows = db.prepare('SELECT id, kata, dasar, jenis_entri, turunan, gabungan_kata, peribahasa, terkait, peribahasa_terkait FROM entries').all();
    console.log(`📊 Loaded ${rows.length.toLocaleString()} entries.`);

    const wordMap = new Map();
    const dasarMap = new Map();
    const phraseMap = new Map();
    const peribahasaMap = new Map();

    for (const row of rows) {
        wordMap.set(row.kata, row);
    }

    console.log('🧠 Building in-memory relationship indices...');
    for (const row of rows) {
        let root = row.dasar || getAffixStripRoot(row.kata, wordMap);
        if (root && root !== row.kata) {
            if (!dasarMap.has(root)) dasarMap.set(root, []);
            dasarMap.get(root).push(row);
        }

        if (row.jenis_entri === 'frasa' || (row.jenis_entri === 'kata' && row.kata.includes(' '))) {
            const roots = getConstituentRoots(row.kata, wordMap);
            for (const r of roots) {
                if (!phraseMap.has(r)) phraseMap.set(r, []);
                phraseMap.get(r).push(row.kata);
            }
        } else if (row.jenis_entri === 'peribahasa') {
            const roots = getConstituentRoots(row.kata, wordMap);
            for (const r of roots) {
                if (!peribahasaMap.has(r)) peribahasaMap.set(r, []);
                peribahasaMap.get(r).push(row.kata);
            }
        }
    }

    console.log('🧬 Scanning and associating related words...');
    const updates = [];
    let processedCount = 0;

    for (const row of rows) {
        const W = row.kata;
        const isPhrase = row.jenis_entri === 'frasa' || W.includes(' ');
        const isProverb = row.jenis_entri === 'peribahasa';
        
        const myRoot = row.dasar || getAffixStripRoot(W, wordMap);
        const isRoot = !row.dasar && !getAffixStripRoot(W, wordMap);

        const turunanSet = new Set(cleanAndSplitPipe(row.turunan));
        const gabunganSet = new Set(cleanAndSplitPipe(row.gabungan_kata));
        const terkaitSet = new Set();
        
        // Load existing peribahasa_terkait and expand abbreviations immediately
        const peribahasaTerkaitSet = new Set(
            cleanAndSplitPipe(expandAbbreviations(row.peribahasa_terkait))
        );

        /**
         * TIERED LOGIC
         */
        if (isPhrase || isProverb) {
            // TIER 3: PHRASES & PROVERBS
            // link back to specific parents found inside the text
            const constituentRoots = getConstituentRoots(W, wordMap);
            for (const cr of constituentRoots) {
                if (cr !== W) terkaitSet.add(cr);
            }
        } else {
            // TIER 1 & 2: ROOTS AND DERIVATIVES
            
            // 1. If I am a root, add my children
            const children = dasarMap.get(W);
            if (children) {
                for (const child of children) {
                    if (child.kata === W) continue;
                    if (child.kata.includes(' ') || child.jenis_entri === 'frasa') {
                        gabunganSet.add(child.kata);
                    } else {
                        turunanSet.add(child.kata);
                    }
                }
            }

            // 2. If I have a root, add my parent and siblings (other words only)
            if (myRoot && myRoot !== W) {
                terkaitSet.add(myRoot);
                const siblings = dasarMap.get(myRoot);
                if (siblings) {
                    for (const sib of siblings) {
                        if (sib.id !== row.id && !sib.kata.includes(' ')) {
                            terkaitSet.add(sib.kata);
                        }
                    }
                }
            }

            // 3. Proactive Proverb/Phrase Discovery (Roots and Derivatives)
            // Even if I'm a derivative, I want to find proverbs/phrases associated with my concept
            const searchTerms = new Set([W.toLowerCase()]);
            if (myRoot) searchTerms.add(myRoot.toLowerCase());

            for (const term of searchTerms) {
                // Find phrases containing this concept
                const associatedPhrases = phraseMap.get(term);
                if (associatedPhrases) {
                    for (const p of associatedPhrases) {
                        if (p !== W) gabunganSet.add(p);
                    }
                }

                // Find proverbs containing this concept
                const associatedProverbs = peribahasaMap.get(term);
                if (associatedProverbs) {
                    for (const prov of associatedProverbs) {
                        if (prov !== W) {
                            peribahasaTerkaitSet.add(expandAbbreviations(prov));
                        }
                    }
                }
            }
        }

        // 4. AGGREGATION
        const cleanTurunanList = [...turunanSet].filter(x => x !== W).sort();
        const cleanGabunganList = [...gabunganSet].filter(x => x !== W).sort();
        
        // Terkait = Turunan + Gabungan + Discovered Parents/Siblings
        cleanTurunanList.forEach(item => terkaitSet.add(item));
        cleanGabunganList.forEach(item => terkaitSet.add(item));
        const terkaitList = [...terkaitSet].filter(x => x !== W).sort();

        /**
         * UNIVERSAL SYNC: Sync 'peribahasa' and 'peribahasa_terkait'
         * Moved outside of isRoot to ensure every entry is expanded and merged.
         */
        const originalPeribahasaExpanded = expandAbbreviations(row.peribahasa);
        const mergedProverbs = new Set([
            ...cleanAndSplitPipe(originalPeribahasaExpanded),
            ...peribahasaTerkaitSet
        ]);
        
        const finalMergedProverbsString = [...mergedProverbs]
            .filter(x => x !== W)
            .sort()
            .join(' | ') || null;

        const finalPeribahasa = finalMergedProverbsString;
        const finalPeribahasaTerkait = finalMergedProverbsString;

        const finalTurunan = cleanTurunanList.join(' | ') || null;
        const finalGabungan = cleanGabunganList.join(' | ') || null;
        const finalTerkait = terkaitList.join(' | ') || null;

        // Change Detection
        if (
            finalTurunan !== (row.turunan || null) || 
            finalGabungan !== (row.gabungan_kata || null) || 
            finalTerkait !== (row.terkait || null) ||
            finalPeribahasa !== (row.peribahasa || null) ||
            finalPeribahasaTerkait !== (row.peribahasa_terkait || null)
        ) {
            updates.push({
                id: row.id,
                kata: W,
                turunan: finalTurunan,
                gabungan_kata: finalGabungan,
                terkait: finalTerkait,
                peribahasa: finalPeribahasa,
                peribahasa_terkait: finalPeribahasaTerkait
            });
        }

        processedCount++;
        if (processedCount % 50000 === 0) {
            console.log(`   Processed ${processedCount.toLocaleString()} / ${rows.length.toLocaleString()}...`);
        }
    }

    console.log(`✨ Found ${updates.length.toLocaleString()} entries needing updates.`);

    if (dryRun) {
        console.log('\n🔍 Sample dry-run updates (first 5):');
        updates.slice(0, 5).forEach((up) => {
            console.log(`- ${up.kata}: Rel:[${up.terkait}] Prov:[${up.peribahasa_terkait}]`);
        });
    } else if (updates.length > 0) {
        console.log('💾 Writing updates to database...');
        const updateStmt = db.prepare(`
            UPDATE entries
            SET turunan = ?, gabungan_kata = ?, terkait = ?, peribahasa = ?, peribahasa_terkait = ?
            WHERE id = ?
        `);

        db.transaction((items) => {
            for (const i of items) {
                updateStmt.run(i.turunan, i.gabungan_kata, i.terkait, i.peribahasa, i.peribahasa_terkait, i.id);
            }
        })(updates);
        
        db.pragma('wal_checkpoint(PASSIVE)');
    }

    db.close();
    console.log('🏁 Relation Builder complete.');
}

main().catch(err => {
    console.error('\n💥 Relation Builder Error:', err);
    process.exit(1);
});