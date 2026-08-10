/**
 * helpers/enricher/upserter.js
 * node helpers/enricher/upserter.js         - default; run the upserter to classify slang words
 * node helpers/enricher/upserter.js validate - run a read-only dry run against a random entry
 * node helpers/enricher/upserter.js merge    - truncate db-shm and db-wal and merge to .db
 * node helpers/enricher/upserter.js reset    - reset worker claims
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { processBatchWithAI } = require('../ai-engine/ai-provider.js');
const { validateAIResponse } = require('../ai-engine/ai-validator');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'src', 'database', 'kamus-terbuka.db');
const PROMPT_PATH = path.join(__dirname, '..', 'datasets', 'system_prompt_slang.txt');
const WORKER_ID = uuidv4().slice(0, 8);
const BATCH_SIZE = Number(process.env.UPSERTER_BATCH_SIZE || 10);
const STALE_THRESHOLD_MS = 180 * 1000;
const CLAIM_LEASE_MS = Number(process.env.UPSERTER_CLAIM_LEASE_MS || 5 * 60 * 1000);
const SQLITE_RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SQLITE_RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

function isRetryableSqliteError(err) {
    if (!err) return false;
    if (SQLITE_RETRYABLE_CODES.has(err.code)) return true;
    return /database is locked|database is busy|SQLITE_BUSY/i.test(err.message || '');
}

async function retrySqliteOperation(operation, description) {
    let attempt = 0;
    while (true) {
        try {
            return await operation();
        } catch (err) {
            if (!isRetryableSqliteError(err)) {
                throw err;
            }
            attempt += 1;
            console.warn(`⚠️ SQLite busy during ${description}; retrying in ${SQLITE_RETRY_DELAY_MS}ms (attempt ${attempt})...`);
            await sleep(SQLITE_RETRY_DELAY_MS);
        }
    }
}

function ensureSchema(db) {
    db.pragma('journal_mode = WAL');

    db.prepare(`
        CREATE TABLE IF NOT EXISTS worker_heartbeats (
            worker_id TEXT PRIMARY KEY,
            last_heartbeat INTEGER
        )
    `).run();

    const columns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);

    const requiredCols = [
        { name: 'bahasa_gaul', def: ' INTEGER DEFAULT 0' },
        { name: 'terkait', def: ' TEXT' },
        { name: 'upserted', def: ' INTEGER DEFAULT 0' },
        { name: 'upserted_worker_id', def: ' TEXT' },
        { name: 'upserted_claim_expires_at', def: ' INTEGER' },
        { name: 'upserted_at', def: ' INTEGER' }
    ];

    for (const col of requiredCols) {
        if (!columns.includes(col.name)) {
            db.prepare(`ALTER TABLE entries ADD COLUMN ${col.name}${col.def}`).run();
        }
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_upserted ON entries(upserted, upserted_worker_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_bahasa_gaul ON entries(bahasa_gaul)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_worker_heartbeats ON worker_heartbeats(last_heartbeat)').run();
}

function getMaintenanceLockInfo(db) {
    const latest = db.prepare('SELECT MAX(last_heartbeat) AS last FROM worker_heartbeats').get();
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

function getRandomSampleRow(db) {
    return db.prepare(`
        SELECT id, kata, lema, makna
        FROM entries
        ORDER BY RANDOM()
        LIMIT 1
    `).get();
}

function buildClaimReleaseSql(workerIds) {
    const placeholders = workerIds.map(() => '?').join(', ');
    return `UPDATE entries SET upserted = 0, upserted_worker_id = NULL, upserted_claim_expires_at = NULL WHERE upserted = 2 AND upserted_worker_id IN (${placeholders})`;
}

function makeClaimTransaction(db, workerId) {
    const claimStmt = db.prepare(`
        UPDATE entries
        SET upserted = 2,
            upserted_worker_id = ?,
            upserted_claim_expires_at = ?
        WHERE id = ?
          AND (
              upserted = 0
              OR (
                  upserted = 2
                  AND (
                      upserted_worker_id IS NULL
                      OR upserted_claim_expires_at IS NULL
                      OR upserted_claim_expires_at <= ?
                  )
              )
          )
    `);

    return db.transaction((limit, excludedIds = []) => {
        const now = Date.now();
        const params = [now];
        const excludedClause = excludedIds.length > 0
            ? ` AND id NOT IN (${excludedIds.map(() => '?').join(', ')})`
            : '';

        if (excludedIds.length > 0) {
            params.push(...excludedIds);
        }

        params.push(limit);

        const pendingRows = db.prepare(`
            SELECT id, kata, lema, makna
            FROM entries
            WHERE (
                upserted = 0
                OR (
                    upserted = 2
                    AND (
                        upserted_worker_id IS NULL
                        OR upserted_claim_expires_at IS NULL
                        OR upserted_claim_expires_at <= ?
                    )
                )
            )${excludedClause}
            ORDER BY id ASC
            LIMIT ?
        `).all(...params);

        const claimedRows = [];
        for (const row of pendingRows) {
            const expiresAt = now + CLAIM_LEASE_MS;
            const info = claimStmt.run(workerId, expiresAt, row.id, now);
            if (info.changes === 1) {
                claimedRows.push(row);
            }
        }

        return claimedRows;
    });
}

function makeSaveTransaction(db) {
    const updateStmt = db.prepare(`
        UPDATE entries
        SET bahasa_gaul = @bahasa_gaul,
            upserted = 1,
            upserted_at = @upserted_at,
            upserted_worker_id = NULL,
            upserted_claim_expires_at = NULL
        WHERE id = @id AND upserted_worker_id = @worker_id
    `);

    return db.transaction((row, aiResult, workerId) => {
        const now = Date.now();
        const bahasaGaulValue = aiResult.bahasa_gaul === true ? 1 : 0;

        return updateStmt.run({
            id: row.id,
            worker_id: workerId,
            bahasa_gaul: bahasaGaulValue,
            upserted_at: now,
        });
    });
}

function makeHeartbeat(db) {
    const updateHeartbeat = () => {
        db.prepare('INSERT OR REPLACE INTO worker_heartbeats (worker_id, last_heartbeat) VALUES (?, ?)')
            .run(WORKER_ID, Date.now());
    };

    const removeHeartbeat = () => {
        db.prepare('DELETE FROM worker_heartbeats WHERE worker_id = ?').run(WORKER_ID);
    };

    return { updateHeartbeat, removeHeartbeat };
}

function refreshClaimLease(db, rowId, workerId) {
    const expiresAt = Date.now() + CLAIM_LEASE_MS;
    return db.prepare(`
        UPDATE entries
        SET upserted_claim_expires_at = ?
        WHERE id = ? AND upserted = 2 AND upserted_worker_id = ?
    `).run(expiresAt, rowId, workerId).changes;
}

function reclaimStaleClaims(db) {
    const now = Date.now();
    const cutoff = now - STALE_THRESHOLD_MS;
    const staleWorkers = db.prepare('SELECT worker_id FROM worker_heartbeats WHERE last_heartbeat < ?').all(cutoff);
    let changes = 0;

    if (staleWorkers.length > 0) {
        const staleWorkerIds = staleWorkers.map((row) => row.worker_id);
        const sql = buildClaimReleaseSql(staleWorkerIds);
        const info = db.prepare(sql).run(...staleWorkerIds);
        changes += info.changes;
    }

    const expiredLeaseInfo = db.prepare(`
        UPDATE entries
        SET upserted = 0,
            upserted_worker_id = NULL,
            upserted_claim_expires_at = NULL
        WHERE upserted = 2 AND upserted_claim_expires_at IS NOT NULL AND upserted_claim_expires_at <= ?
    `).run(now);

    return changes + expiredLeaseInfo.changes;
}

const SLANG_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    bahasa_gaul: { type: 'boolean' }
                },
                required: ['id', 'bahasa_gaul']
            }
        }
    },
    required: ['entries']
};

async function runUpserter(db, dbPath) {
    const claimBatch = makeClaimTransaction(db, WORKER_ID);
    const saveEntry = makeSaveTransaction(db);
    const { updateHeartbeat, removeHeartbeat } = makeHeartbeat(db);

    let processed = 0;
    let shutdownRequested = false;

    const requestShutdown = (signal) => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        console.log(`\n🛑 [${WORKER_ID}] Received ${signal}. Finishing current work and shutting down...`);
    };

    const finalize = (reason) => {
        try {
            db.prepare('UPDATE entries SET upserted = 0, upserted_worker_id = NULL, upserted_claim_expires_at = NULL WHERE upserted = 2 AND upserted_worker_id = ?').run(WORKER_ID);
            removeHeartbeat();
            db.pragma('wal_checkpoint(PASSIVE)');
        } catch (err) {
            console.warn(`⚠️ [${WORKER_ID}] Finalization warning: ${err.message}`);
        }

        try {
            db.close();
        } catch (err) {
            console.warn(`⚠️ [${WORKER_ID}] Database close warning: ${err.message}`);
        }

        console.log(`✅ [${WORKER_ID}] ${reason}. Processed ${processed} row(s).`);
    };

    process.on('SIGINT', () => requestShutdown('SIGINT'));
    process.on('SIGTERM', () => requestShutdown('SIGTERM'));

    console.log(`🐝 Slang Upserter [${WORKER_ID}] started on ${dbPath}`);
    console.log(`📦 Batch size: ${BATCH_SIZE}`);

    await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');

    while (!shutdownRequested) {
        await retrySqliteOperation(() => reclaimStaleClaims(db), 'stale-claim reclamation');

        let batchSuccesses = 0;
        const excludedIds = new Set();
        let continueAfterBatch = false;

        try {
            while (!shutdownRequested && batchSuccesses < BATCH_SIZE) {
                const remainingSuccesses = BATCH_SIZE - batchSuccesses;
                const claimedRows = await retrySqliteOperation(
                    () => claimBatch(remainingSuccesses, [...excludedIds]),
                    'claim transaction'
                );

                if (claimedRows.length === 0) {
                    break;
                }

                console.log(`\n💎 [${WORKER_ID}] Claimed ${claimedRows.length} row(s) for slang classification.`);

                // Call the AI in batch for all claimed rows
                try {
                    // Refresh leases for all claimed rows
                    for (const row of claimedRows) {
                        await retrySqliteOperation(
                            () => refreshClaimLease(db, row.id, WORKER_ID),
                            `lease refresh for id=${row.id}`
                        );
                    }

                    console.log(`🤖 Processing batch of ${claimedRows.length} with AI...`);
                    const results = await processBatchWithAI(claimedRows, {
                        promptPath: PROMPT_PATH,
                        responseSchema: SLANG_RESPONSE_SCHEMA,
                    });

                    const validated = validateAIResponse(results, claimedRows, {
                        requiredFields: ['id', 'bahasa_gaul'],
                    });

                    // Create a lookup map for faster processing
                    const resultsMap = new Map(validated.map(item => [item.id, item]));

                    for (const row of claimedRows) {
                        const aiResult = resultsMap.get(row.id);
                        if (!aiResult) {
                            throw new Error(`AI response missing expected id: ${row.id}`);
                        }

                        const saveInfo = await retrySqliteOperation(
                            () => saveEntry(row, aiResult, WORKER_ID),
                            `save transaction for id=${row.id}`
                        );

                        if (saveInfo.changes === 0) {
                            console.warn(`   ⚠️ [${WORKER_ID}] Skipped id=${row.id} because it was reclaimed or completed.`);
                            continue;
                        }

                        processed += 1;
                        batchSuccesses += 1;
                    }

                    console.log(`   ✅ Successfully classified ${claimedRows.length} entries.`);
                    await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');

                } catch (err) {
                    console.error(`   ❌ [${WORKER_ID}] Failed batch: ${err.message}`);
                    for (const row of claimedRows) {
                        excludedIds.add(row.id);
                        try {
                            await retrySqliteOperation(
                                () => db.prepare('UPDATE entries SET upserted = 0, upserted_worker_id = NULL, upserted_claim_expires_at = NULL WHERE id = ? AND upserted = 2 AND upserted_worker_id = ?').run(row.id, WORKER_ID),
                                `release claim for id=${row.id}`
                            );
                        } catch (releaseErr) {
                            // ignore
                        }
                    }
                    await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');
                    await sleep(2000);
                }
            }

            if (batchSuccesses > 0) {
                console.log(`✅ [${WORKER_ID}] Batch completed with ${batchSuccesses} classification(s).`);
            } else if (excludedIds.size > 0) {
                console.log(`↩️ [${WORKER_ID}] Retrying failed rows in the next cycle.`);
            } else {
                console.log(`🏁 [${WORKER_ID}] No more pending rows to classify.`);
            }

            await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');
            continueAfterBatch = batchSuccesses > 0 || excludedIds.size > 0;
        } finally {
            await retrySqliteOperation(() => db.pragma('wal_checkpoint(PASSIVE)'), 'WAL checkpoint');
        }

        if (!continueAfterBatch) {
            break;
        }
    }

    finalize(shutdownRequested ? 'Shutdown complete' : 'Slang classification complete');
}

async function runValidationDryRun(db, dbPath) {
    const sampleRow = getRandomSampleRow(db);
    if (!sampleRow) {
        throw new Error(`No entries found in ${dbPath} to validate.`);
    }

    console.log(`🧪 Validation dry-run selected random entry id=${sampleRow.id} (${sampleRow.kata})`);

    const results = await processBatchWithAI([sampleRow], {
        promptPath: PROMPT_PATH,
        responseSchema: SLANG_RESPONSE_SCHEMA,
    });

    const [validatedEntry] = validateAIResponse(results, [sampleRow], {
        requiredFields: ['id', 'bahasa_gaul'],
    });

    console.log('✅ Validation dry-run succeeded. AI returned valid classification:');
    console.dir(validatedEntry, { depth: null, colors: true });
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'work';
    const dbPath = args[1] ? path.resolve(args[1]) : DEFAULT_DB_PATH;

    if (!fs.existsSync(PROMPT_PATH)) {
        throw new Error(`Slang prompt file not found at ${PROMPT_PATH}`);
    }

    if (!fs.existsSync(dbPath)) {
        throw new Error(`Database not found at ${dbPath}`);
    }

    if (command === 'validate') {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            await runValidationDryRun(db, dbPath);
        } finally {
            db.close();
        }
        return;
    }

    const db = new Database(dbPath);
    ensureSchema(db);

    if (command === 'merge') {
        const lock = getMaintenanceLockInfo(db);
        if (lock.locked) {
            console.error('❌ Maintenance rejected: another upserter worker is still active.');
            console.error(`⏳ Please wait ${lock.timeStr} after stopping all workers before retrying.`);
            db.close();
            process.exit(1);
        }

        console.log('🧹 Maintenance: Merging WAL and shrinking database...');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        console.log('✅ Merge complete.');
        return;
    }

    if (command === 'reset') {
        const lock = getMaintenanceLockInfo(db);
        if (lock.locked) {
            console.error('❌ Reset rejected: other workers are still active.');
            db.close();
            process.exit(1);
        }
        console.log('♻️ Resetting upserter claims...');
        db.prepare('UPDATE entries SET upserted = 0, upserted_worker_id = NULL, upserted_claim_expires_at = NULL WHERE upserted = 2').run();
        db.prepare('DELETE FROM worker_heartbeats').run();
        db.close();
        console.log('✅ Reset complete.');
        return;
    }

    await runUpserter(db, dbPath);
}

main().catch((err) => {
    console.error('\n💥 Fatal Execution Error:', err);
    process.exit(1);
});
