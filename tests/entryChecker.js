/**
 * tests/entryChecker.js
 * Interactive terminal query checker for kamus-terbuka SQLite database.
 */

const readline = require('readline');
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

// Main Menu Loop
async function mainMenu() {
  console.log('\n==================================');
  console.log('   📖 KAMUS TERBUKA ENTRY CHECKER  ');
  console.log('==================================');
  console.log('1. Search Entry');
  console.log('2. Exit');

  const choice = (await prompt('\nSelect option (1-2): ')).trim();

  if (choice === '1') {
    await searchFlow();
    await mainMenu();
  } else if (choice === '2') {
    console.log('\nExiting program. Goodbye! 👋');
    db.close();
    rl.close();
    process.exit(0);
  } else {
    console.log('⚠️ Invalid option. Please enter 1 or 2.');
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