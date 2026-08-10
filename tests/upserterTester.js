/**
 * tests/upserterTester.js
 *
 * Tests the relation-builder and upserter functionality on a temporary
 * test SQLite database to verify correct relationship population and slang classification logic.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const TEST_DB_PATH = path.join(__dirname, 'kamus-terbuka-test.db');
const RELATION_BUILDER_PATH = path.join(__dirname, '..', 'helpers', 'enricher', 'relation-builder.js');
const UPSERTER_PATH = path.join(__dirname, '..', 'helpers', 'enricher', 'upserter.js');

function setupTestDatabase() {
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.unlinkSync(TEST_DB_PATH);
    }

    const db = new Database(TEST_DB_PATH);
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
            dasar TEXT,
            jenis_entri TEXT
        );
    `);

    const insertStmt = db.prepare(`
        INSERT INTO entries (kata, dasar, jenis_entri, tags_sumber, makna)
        VALUES (?, ?, ?, 'TEST_SUITE', ?)
    `);

    // Add standard test data
    insertStmt.run('makan', 'makan', 'kata', 'Memasukkan makanan.');
    insertStmt.run('dimakan', 'makan', 'kata', 'Dikonsumsi oleh subjek.');
    insertStmt.run('makan angin', 'makan', 'frasa', 'Berjalan-jalan mencari udara bersih.');

    // Add slang test data
    insertStmt.run('mabar', 'mabar', 'kata', 'Main bareng game online.');

    // Add prefix test data (berkontestasi has no dasar, but root is kontestasi)
    insertStmt.run('kontestasi', 'kontes', 'kata', 'Persaingan.');
    insertStmt.run('berkontestasi', null, 'kata', 'Melakukan persaingan.');

    db.close();
    console.log('✅ Temporary test database populated successfully.');
}

function verifyRelations() {
    console.log('📖 Reading relationship entries from test database...');
    const db = new Database(TEST_DB_PATH);
    const rows = db.prepare('SELECT id, kata, turunan, gabungan_kata, terkait FROM entries').all();

    console.log('\nResulting Database Records:');
    console.dir(rows, { depth: null, colors: true });

    const makanRow = rows.find(r => r.kata === 'makan');
    const kontestasiRow = rows.find(r => r.kata === 'kontestasi');

    if (!makanRow) {
        throw new Error('❌ Test failed: "makan" entry is missing.');
    }

    if (!makanRow.turunan || !makanRow.turunan.includes('dimakan')) {
        throw new Error(`❌ Test failed: "makan" has incorrect turunan: "${makanRow.turunan}". Expected to include "dimakan".`);
    }

    if (!makanRow.gabungan_kata || !makanRow.gabungan_kata.includes('makan angin')) {
        throw new Error(`❌ Test failed: "makan" has incorrect gabungan_kata: "${makanRow.gabungan_kata}". Expected to include "makan angin".`);
    }

    const makanTerkait = makanRow.terkait ? makanRow.terkait.split(' | ') : [];
    if (!makanTerkait.includes('dimakan') || !makanTerkait.includes('makan angin')) {
        throw new Error(`❌ Test failed: "makan" has incorrect terkait array: "${makanRow.terkait}". Expected both "dimakan" and "makan angin".`);
    }

    if (!kontestasiRow) {
        throw new Error('❌ Test failed: "kontestasi" entry is missing.');
    }

    if (!kontestasiRow.turunan || !kontestasiRow.turunan.includes('berkontestasi')) {
        throw new Error(`❌ Test failed: "kontestasi" did not dynamically resolve and link "berkontestasi" as a turunan (found: "${kontestasiRow.turunan}").`);
    }

    db.close();
    console.log('\n🎉 Relationship tests PASSED successfully!');
}

function runTests() {
    try {
        console.log('--- 1. Setting up Test Database ---');
        setupTestDatabase();

        console.log('\n--- 2. Running Relation Builder (Local) ---');
        execSync(`node "${RELATION_BUILDER_PATH}" "${TEST_DB_PATH}"`, { stdio: 'inherit' });

        console.log('\n--- 3. Verifying Local Relations ---');
        verifyRelations();

        console.log('\n--- 4. Running Slang Classifier Dry Run (Validation Mode) ---');
        // Run validation mode against test database to verify upserter AI structures
        execSync(`node "${UPSERTER_PATH}" validate "${TEST_DB_PATH}"`, { stdio: 'inherit' });

        console.log('\n🎉 All upserter and relation builder system checks PASSED!');
    } catch (err) {
        console.error('\n❌ Integration Test Failed:', err.message);
        process.exit(1);
    } finally {
        if (fs.existsSync(TEST_DB_PATH)) {
            try {
                fs.unlinkSync(TEST_DB_PATH);
                fs.unlinkSync(`${TEST_DB_PATH}-wal`);
                fs.unlinkSync(`${TEST_DB_PATH}-shm`);
            } catch (e) {
                // ignore
            }
        }
    }
}

runTests();
