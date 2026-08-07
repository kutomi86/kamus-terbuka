/**
 * helpers/enricher.js
 * node helpers/enricher.js       - default; run the enricher to enrich the database
 * node helpers/enricher.js validate - run a read-only dry run against a random entry
 * node helpers/enricher.js merge - truncate db-shm and db-wal and merge to .db
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { processBatchWithAI } = require('./ai-provider');
const { validateAIResponse } = require('./ai-validator');
const { ENRICHER_RESPONSE_SCHEMA } = require('./datasets/response-schemas.js');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'src', 'database', 'kamus-terbuka.db');
const PROMPT_PATH = path.join(__dirname, 'datasets', 'system_prompt_all.txt');
const WORKER_ID = uuidv4().slice(0, 8);
const BATCH_SIZE = Number(process.env.ENRICHER_BATCH_SIZE || 15);
const STALE_THRESHOLD_MS = 180 * 1000;
const CLAIM_LEASE_MS = Number(process.env.ENRICHER_CLAIM_LEASE_MS || 5 * 60 * 1000);
const REQUIRED_ENRICHED_FIELDS = ['id', 'kata', 'lema', 'pelafalan', 'makna', 'jenis_entri'];
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

const sanitizeSqlValue = (val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
        const trimmed = val.trim();
        return trimmed === '' ? null : trimmed;
    }
    if (Array.isArray(val)) return val.map((item) => sanitizeSqlValue(item)).filter(Boolean).join(', ') || null;
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
};

function ensureSchema(db) {
    db.pragma('journal_mode = WAL');

    db.prepare(`
        CREATE TABLE IF NOT EXISTS worker_heartbeats (
            worker_id TEXT PRIMARY KEY,
            last_heartbeat INTEGER
        )
    `).run();

    const columns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
    const requiredCols = ['enriched', 'enriched_worker_id', 'enriched_claim_expires_at'];

    for (const column of requiredCols) {
        if (!columns.includes(column)) {
            const definition = column === 'enriched'
                ? ' INTEGER DEFAULT 0'
                : column === 'enriched_claim_expires_at'
                    ? ' INTEGER'
                    : ' TEXT';
            db.prepare(`ALTER TABLE entries ADD COLUMN ${column}${definition}`).run();
        }
    }

    db.prepare('CREATE INDEX IF NOT EXISTS idx_entries_enriched ON entries(enriched, enriched_worker_id)').run();
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
        SELECT id, kata, lema, pelafalan, etimologi, makna,
               tags_kelas, tags_bahasa, tags_bidang, tags_ragam, tags_sumber,
               contoh, turunan, gabungan_kata, peribahasa, kiasan, varian, dasar,
               jenis_entri
        FROM entries
        ORDER BY RANDOM()
        LIMIT 1
    `).get();
}

function inferJenisEntri(row) {
    if (!row) return 'lainnya';
    if (row.peribahasa) return 'peribahasa';
    if (row.kata && row.kata.includes(' ')) return 'frasa';
    if (row.kata && !row.kata.includes(' ')) return 'kata';
    return 'lainnya';
}

function normalizeJenisEntri(value, row) {
    const allowed = new Set(['kata', 'frasa', 'peribahasa', 'lainnya']);
    if (allowed.has(value)) return value;
    return inferJenisEntri(row);
}

function selectPreferredValue(originalValue, aiValue) {
    const cleaned = sanitizeSqlValue(aiValue);
    if (cleaned !== null) return cleaned;
    return sanitizeSqlValue(originalValue);
}

function buildClaimReleaseSql(workerIds) {
    const placeholders = workerIds.map(() => '?').join(', ');
    return `UPDATE entries SET enriched = 0, enriched_worker_id = NULL, enriched_claim_expires_at = NULL WHERE enriched = 2 AND enriched_worker_id IN (${placeholders})`;
}

function makeClaimTransaction(db, workerId) {
    const claimStmt = db.prepare(`
        UPDATE entries
        SET enriched = 2,
            enriched_worker_id = ?,
            enriched_claim_expires_at = ?
        WHERE id = ?
          AND (
              enriched = 0
              OR (
                  enriched = 2
                  AND (
                      enriched_worker_id IS NULL
                      OR enriched_claim_expires_at IS NULL
                      OR enriched_claim_expires_at <= ?
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
            SELECT id, kata, lema, pelafalan, etimologi, makna,
                         tags_kelas, tags_bahasa, tags_bidang, tags_ragam, tags_sumber,
                         contoh, turunan, gabungan_kata, peribahasa, kiasan, varian, dasar,
                         jenis_entri
            FROM entries
            WHERE (
                enriched = 0
                OR (
                    enriched = 2
                    AND (
                        enriched_worker_id IS NULL
                        OR enriched_claim_expires_at IS NULL
                        OR enriched_claim_expires_at <= ?
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
        SET kata = @kata,
                lema = @lema,
                pelafalan = @pelafalan,
                etimologi = @etimologi,
                makna = @makna,
                tags_kelas = @tags_kelas,
                tags_bahasa = @tags_bahasa,
                tags_bidang = @tags_bidang,
                tags_ragam = @tags_ragam,
                tags_sumber = @tags_sumber,
                contoh = @contoh,
                turunan = @turunan,
                gabungan_kata = @gabungan_kata,
                peribahasa = @peribahasa,
                kiasan = @kiasan,
                varian = @varian,
                dasar = @dasar,
                jenis_entri = @jenis_entri,
                enriched = 1,
                enriched_worker_id = NULL,
                enriched_claim_expires_at = NULL
        WHERE id = @id AND enriched_worker_id = @worker_id
    `);

    return db.transaction((row, aiEntry, workerId) => {
        const normalized = aiEntry || {};
        const now = Date.now();

        const payload = {
            id: row.id,
            worker_id: workerId,
            kata: selectPreferredValue(row.kata, normalized.kata),
            lema: selectPreferredValue(row.lema, normalized.lema),
            pelafalan: selectPreferredValue(row.pelafalan, normalized.pelafalan),
            etimologi: selectPreferredValue(row.etimologi, normalized.etimologi),
            makna: selectPreferredValue(row.makna, normalized.makna),
            tags_kelas: selectPreferredValue(row.tags_kelas, normalized.tags_kelas),
            tags_bahasa: selectPreferredValue(row.tags_bahasa, normalized.tags_bahasa),
            tags_bidang: selectPreferredValue(row.tags_bidang, normalized.tags_bidang),
            tags_ragam: selectPreferredValue(row.tags_ragam, normalized.tags_ragam),
            tags_sumber: selectPreferredValue(row.tags_sumber, normalized.tags_sumber),
            contoh: selectPreferredValue(row.contoh, normalized.contoh),
            turunan: selectPreferredValue(row.turunan, normalized.turunan),
            gabungan_kata: selectPreferredValue(row.gabungan_kata, normalized.gabungan_kata),
            peribahasa: selectPreferredValue(row.peribahasa, normalized.peribahasa),
            kiasan: selectPreferredValue(row.kiasan, normalized.kiasan),
            varian: selectPreferredValue(row.varian, normalized.varian),
            dasar: selectPreferredValue(row.dasar, normalized.dasar),
            jenis_entri: normalizeJenisEntri(normalized.jenis_entri, row),
            now,
        };

        return updateStmt.run(payload);
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
        SET enriched_claim_expires_at = ?
        WHERE id = ? AND enriched = 2 AND enriched_worker_id = ?
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
        SET enriched = 0,
            enriched_worker_id = NULL,
            enriched_claim_expires_at = NULL
        WHERE enriched = 2 AND enriched_claim_expires_at IS NOT NULL AND enriched_claim_expires_at <= ?
    `).run(now);

    return changes + expiredLeaseInfo.changes;
}

async function runEnricher(db, dbPath) {
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
            db.prepare('UPDATE entries SET enriched = 0, enriched_worker_id = NULL, enriched_claim_expires_at = NULL WHERE enriched = 2 AND enriched_worker_id = ?').run(WORKER_ID);
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

    console.log(`🐝 Enricher [${WORKER_ID}] started on ${dbPath}`);
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

                console.log(`\n💎 [${WORKER_ID}] Claimed ${claimedRows.length} row(s) for this batch.`);

                for (const row of claimedRows) {
                    if (shutdownRequested || batchSuccesses >= BATCH_SIZE) break;

                    try {
                        await retrySqliteOperation(
                            () => refreshClaimLease(db, row.id, WORKER_ID),
                            `lease refresh for id=${row.id}`
                        );

                        const results = await processBatchWithAI([row], {
                            promptPath: PROMPT_PATH,
                            responseSchema: ENRICHER_RESPONSE_SCHEMA,
                        });

                        const [aiEntry] = validateAIResponse(results, [row], {
                            requiredFields: REQUIRED_ENRICHED_FIELDS,
                        });

                        const saveInfo = await retrySqliteOperation(
                            () => saveEntry(row, aiEntry, WORKER_ID),
                            `save transaction for id=${row.id}`
                        );
                        if (saveInfo.changes === 0) {
                            console.warn(`   ⚠️ [${WORKER_ID}] Skipped id=${row.id} because it was already completed or reclaimed by another worker.`);
                            await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');
                            continue;
                        }

                        processed += 1;
                        batchSuccesses += 1;
                        await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');

                        console.log(`   ✅ [${processed}] Enriched id=${row.id} (${row.kata})`);
                    } catch (err) {
                        console.error(`   ❌ [${WORKER_ID}] Failed id=${row.id}: ${err.message}`);
                        excludedIds.add(row.id);
                        try {
                            await retrySqliteOperation(
                                () => db.prepare('UPDATE entries SET enriched = 0, enriched_worker_id = NULL, enriched_claim_expires_at = NULL WHERE id = ? AND enriched = 2 AND enriched_worker_id = ?').run(row.id, WORKER_ID),
                                `release claim for id=${row.id}`
                            );
                        } catch (releaseErr) {
                            console.warn(`   ⚠️ [${WORKER_ID}] Could not release row ${row.id}: ${releaseErr.message}`);
                        }
                        await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');
                        await sleep(1000);
                    }
                }

                if (shutdownRequested) break;
            }

            if (batchSuccesses > 0) {
                console.log(`✅ [${WORKER_ID}] Batch completed with ${batchSuccesses} successful enrichment(s).`);
            } else if (excludedIds.size > 0) {
                console.log(`↩️ [${WORKER_ID}] No successful enrichments in this batch. Retrying failed rows in the next batch.`);
            } else {
                console.log(`🏁 [${WORKER_ID}] No more pending rows to enrich.`);
            }

            await retrySqliteOperation(() => updateHeartbeat(), 'worker heartbeat update');
            continueAfterBatch = batchSuccesses > 0 || excludedIds.size > 0;
        } finally {
            await retrySqliteOperation(() => db.pragma('wal_checkpoint(PASSIVE)'), 'WAL checkpoint');
            console.log(`   🧹 [${WORKER_ID}] WAL checkpoint completed after batch.`);
        }

        if (!continueAfterBatch) {
            break;
        }
    }

    finalize(shutdownRequested ? 'Shutdown complete' : 'Enrichment complete');
}

async function runValidationDryRun(db, dbPath) {
    const sampleRow = getRandomSampleRow(db);

    if (!sampleRow) {
        throw new Error(`No entries found in ${dbPath} to validate.`);
    }

    console.log(`🧪 Validation dry-run selected random entry id=${sampleRow.id} (${sampleRow.kata})`);

    const results = await processBatchWithAI([sampleRow], {
      promptPath: PROMPT_PATH,
      responseSchema: ENRICHER_RESPONSE_SCHEMA,
    });

    const [validatedEntry] = validateAIResponse(results, [sampleRow], {
        requiredFields: REQUIRED_ENRICHED_FIELDS,
    });

    console.log('✅ Validation dry-run succeeded. The model returned a matching entry and required fields were present.');
    console.dir(validatedEntry, { depth: null, colors: true });
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'work';
    const dbPath = args[1] ? path.resolve(args[1]) : DEFAULT_DB_PATH;

    if (!fs.existsSync(PROMPT_PATH)) {
        throw new Error(`Prompt file not found at ${PROMPT_PATH}`);
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
            console.error('❌ Maintenance rejected: another enricher worker is still active.');
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

    await runEnricher(db, dbPath);
}

main().catch((err) => {
    console.error('\n💥 Fatal Execution Error:', err);
    process.exit(1);
});

/**
 * enricher.js
 * node helpers/enricher.js       - default; run the enricher to enrich the database
 * node helpers/enricher.js validate - run a read-only dry run against a random entry
 * node helpers/enricher.js merge - truncate db-shm and db-wal and merge to .db
 */

/**

    The goal is to enrich each entry in the database to encourage the replacement of `null` values as many as possible. The usage of `null` is only acceptable when an property truly has no sense in being the property of the entry.

    The implementation strategy itself has changed; instead of using a single model to work on a batch of 30, run multiple instances at once instead where each instance works on a single entry. This is to avoid the situation where a single entry with a large amount of text can cause the model to exceed the token limit, which would result in an error and halt the entire batch.

    This is painfully slower, however, this could push the AI to it's maximum potential in enriching the database, particularly in not forgetting the encouragement to replace `null` values with meaningful content.

    The real question is how many instances could be run at once without exceeding the token limit. The answer is not known, but it is expected to be around 10-20 instances at once. And whether or not multiple terminal execution is possible, as it surely will boost the progress, though at the same time would not be different with running multiple instances in a higher number inside one single terminal execution.

    Maybe, the best approach is to run multiple instances in a single terminal execution, but with a limit of 10-20 instances at once. This would allow for better control and monitoring of the process, while still maximizing the potential of the AI to enrich the database. But that would also mean I would need to consider gathering more apikeys. Though, for now, having in total 17 apikeys, with, say, 15 instances running at once, would be a good start, and would also provide me with 2 extra apikeys in case some aren't working; though it's also possible that ONLY around three apikeys would work at a time, and the rest would be already hit 429.

    We could immediately pair the going-to-be-made engine with the existing `ai-provider.js` to make the engine work with the existing logic of apikeys rotation. Following the existing logic, all `enricher.js` really need to do is simply grab 15 entries from the database that doesn't have or have but null or in value of 0 "enriched" property in the database. And then simply loop through the 15, where for each entry, the engine simply calls `ai-provider.js` with one single row (expected to be JSON object as the function parameter) instead of batch. And once an enrichement process (still talking per-entry) is done, mark the entry with "enriched" being true; the engine would then update the database with the enriched entry. Do a checkpoint by merging the `db-shm` and `db-wal` to the main .db file, and then continue to the next batch of 15 entries. And so on, until all entries in the database are enriched.

 */