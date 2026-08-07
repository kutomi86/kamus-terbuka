/**
 * tests/entryChecker.js
 * Interactive terminal query checker for kamus-terbuka SQLite database.
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'src', 'database', 'kamus-terbuka.db');

let db;
try {
  db = new Database(DB_PATH, { fileMustExist: true });
} catch (err) {
  console.error(`❌ Database not found at: ${DB_PATH}`);
  console.error('Please run "node helpers/build-db.js" first to generate the database.');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function getDaySuffix(day) {
  if (day >= 11 && day <= 13) {
    return 'th';
  }

  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

function formatTimestamp(value) {
  if (value === null || value === undefined) {
    return 'Never';
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = Number(partMap.day);

  return `${partMap.weekday}, ${partMap.month} ${day}${getDaySuffix(day)}, ${partMap.year} ${partMap.hour}:${partMap.minute}`;
}

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function getJournalStatus() {
  const walPath = `${DB_PATH}-wal`;
  const shmPath = `${DB_PATH}-shm`;

  const walExists = fs.existsSync(walPath);
  const shmExists = fs.existsSync(shmPath);

  return {
    walExists,
    shmExists,
    walSize: walExists ? fs.statSync(walPath).size : 0,
    shmSize: shmExists ? fs.statSync(shmPath).size : 0,
  };
}

function getAnalysisData() {
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN enriched = 1 THEN 1 ELSE 0 END) AS enriched,
      SUM(CASE WHEN enriched = 0 THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN enriched = 2 THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS timestamped,
      MAX(enriched_at) AS latest_enriched_at
    FROM entries
  `).get();

  const recent = db.prepare(`
    SELECT id, kata, enriched_at
    FROM entries
    WHERE enriched_at IS NOT NULL
    ORDER BY enriched_at DESC, id DESC
    LIMIT 10
  `).all();

  return { summary, recent };
}

function printAnalysis() {
  const { summary, recent } = getAnalysisData();
  const journal = getJournalStatus();
  const total = Number(summary?.total || 0);
  const enriched = Number(summary?.enriched || 0);
  const pending = Number(summary?.pending || 0);
  const claimed = Number(summary?.claimed || 0);
  const timestamped = Number(summary?.timestamped || 0);

  console.log('\n==================================');
  console.log('           ANALYSIS REPORT        ');
  console.log('==================================');
  console.log(`Total entries: ${total}`);
  console.log(`Successfully enriched: ${enriched} (${formatPercent(enriched, total)})`);
  console.log(`Pending: ${pending} (${formatPercent(pending, total)})`);
  console.log(`Claimed: ${claimed} (${formatPercent(claimed, total)})`);
  console.log(`Rows with enriched_at: ${timestamped}`);
  console.log(`Latest successful enrichment: ${formatTimestamp(summary?.latest_enriched_at)}`);

  console.log('\n--- Journal Sidecar Check ---');
  console.log(`WAL file: ${journal.walExists ? `present (${journal.walSize} bytes)` : 'not found'}`);
  console.log(`SHM file: ${journal.shmExists ? `present (${journal.shmSize} bytes)` : 'not found'}`);
  if (journal.walExists || journal.shmExists) {
    console.log('Live stats below include any readable WAL/SHM content, since SQLite opens the current database image.');
  }

  console.log('\n--- Recent Successful Enrichments ---');
  if (recent.length === 0) {
    console.log('No successful enrichment timestamps found yet.');
  } else {
    recent.forEach((row, index) => {
      console.log(`${index + 1}. ${row.kata} (ID: ${row.id}) -> ${formatTimestamp(row.enriched_at)}`);
    });
  }

  console.log('\n--- Suggested Stats ---');
  console.log(`Coverage: ${formatPercent(enriched, total)} of the database has completed enrichment.`);
  console.log(`Timestamp coverage: ${formatPercent(timestamped, enriched || total)} of successful enrichments have a recorded enriched_at value.`);
  console.log(`Backlog: ${pending} rows are still waiting to be enriched.`);
  console.log(`Active claims: ${claimed} rows are currently in-flight.`);
}

// Main Menu Loop
async function mainMenu() {
  console.log('\n==================================');
  console.log('   📖 KAMUS TERBUKA ENTRY CHECKER  ');
  console.log('==================================');
  console.log('1. Search Entry');
  console.log('2. Analysis');
  console.log('3. Exit');

  const choice = (await prompt('\nSelect option (1-3): ')).trim();

  if (choice === '1') {
    await searchFlow();
    await mainMenu();
  } else if (choice === '2') {
    printAnalysis();
    await prompt('\nPress Enter to return to the main menu...');
    await mainMenu();
  } else if (choice === '3') {
    console.log('\nExiting program. Goodbye! 👋');
    db.close();
    rl.close();
    process.exit(0);
  } else {
    console.log('⚠️ Invalid option. Please enter 1, 2, or 3.');
    await mainMenu();
  }
}

// Search and Detail Inspection Flow
async function searchFlow() {
  const query = (await prompt('\nEnter search term (kata/lema): ')).trim();

  if (!query) {
    console.log('⚠️ Search query cannot be empty.');
    return;
  }

  // Search by exact match first, then partial match
  const searchStmt = db.prepare(`
    SELECT id, kata 
    FROM entries 
    WHERE kata LIKE ? OR lema LIKE ? 
    LIMIT 20
  `);

  const results = searchStmt.all(`%${query}%`, `%${query}%`);

  if (results.length === 0) {
    console.log(`\n❌ No entries found matching "${query}".`);
    return;
  }

  console.log(`\nFound ${results.length} result(s):`);
  results.forEach((row, index) => {
    console.log(`${index + 1}. ${row.kata} (${row.id})`);
  });

  const selection = (await prompt('\nEnter item number to view details (or 0 to cancel): ')).trim();
  const selectedIndex = parseInt(selection, 10) - 1;

  if (selection === '0' || isNaN(selectedIndex)) {
    return;
  }

  if (selectedIndex >= 0 && selectedIndex < results.length) {
    const selectedId = results[selectedIndex].id;
    const fetchStmt = db.prepare('SELECT * FROM entries WHERE id = ?');
    const fullEntry = fetchStmt.get(selectedId);

    console.log('\n==================================');
    console.log(`📄 Full Entry: ${fullEntry.kata} (ID: ${fullEntry.id})`);
    console.log('==================================');
    console.dir(fullEntry, { depth: null, colors: true });
  } else {
    console.log('⚠️ Invalid selection index.');
  }
}

// Start Program
mainMenu().catch((err) => {
  console.error('Fatal CLI Error:', err);
  db.close();
  rl.close();
  process.exit(1);
});