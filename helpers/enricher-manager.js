/**
 * helpers/enricher-manager.js
 *
 * Usage:
 *   node helpers/enricher-manager.js [workerCount]
 *   node helpers/enricher-manager.js 8 --restart
 *   node helpers/enricher-manager.js --workers=8 --restart
 */

require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_WORKERS = 4;
const ENRICHER_SCRIPT = path.join(__dirname, 'enricher.js');

function parseArgs(argv) {
  let workerCount = DEFAULT_WORKERS;
  let restartFailed = false;

  for (const arg of argv) {
    if (/^\d+$/.test(arg)) {
      workerCount = Math.max(1, parseInt(arg, 10));
      continue;
    }

    if (arg === '--restart') {
      restartFailed = true;
      continue;
    }

    if (arg === '--no-restart') {
      restartFailed = false;
      continue;
    }

    if (arg.startsWith('--workers=')) {
      const parsed = parseInt(arg.split('=')[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        workerCount = parsed;
      }
    }
  }

  return { workerCount, restartFailed };
}

function startWorker(index, restartFailed, state) {
  const child = spawn(process.execPath, [ENRICHER_SCRIPT], {
    env: {
      ...process.env,
      ENRICHER_MANAGER_WORKER_INDEX: String(index + 1),
      ENRICHER_MANAGER_WORKER_COUNT: String(state.workerCount),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const prefix = `[worker ${index + 1}/${state.workerCount}]`;
  const newLiner = (chunk) => chunk.toString().toLowerCase().includes("requesting batch processing") ? `\n` : "";

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${newLiner(chunk)}${prefix} ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${newLiner(chunk)}${prefix} ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    state.children.delete(index);

    if (state.shuttingDown) {
      return;
    }

    const finishedCleanly = code === 0 && !signal;
    if (finishedCleanly) {
      console.log(`${prefix} exited cleanly.`);
    } else {
      console.warn(`${prefix} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.`);
      if (!restartFailed) {
        state.hadNonRecoverableFailure = true;
      }
    }

    if (!finishedCleanly && restartFailed) {
      console.log(`${prefix} restarting...`);
      setTimeout(() => {
        if (!state.shuttingDown) {
          state.children.set(index, startWorker(index, restartFailed, state));
        }
      }, 1000);
      return;
    }

    if (state.children.size === 0) {
      console.log('All enricher workers have exited.');
      process.exit(state.hadNonRecoverableFailure ? 1 : 0);
    }
  });

  return child;
}

function stopAllWorkers(state, signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  console.log(`\nStopping enricher workers due to ${signal}...`);

  for (const child of state.children.values()) {
    child.kill(signal);
  }
}

function main() {
  const { workerCount, restartFailed } = parseArgs(process.argv.slice(2));
  const state = {
    workerCount,
    restartFailed,
    shuttingDown: false,
    hadNonRecoverableFailure: false,
    children: new Map(),
  };

  console.log(`Starting ${workerCount} enricher worker(s). Restart failed workers: ${restartFailed ? 'yes' : 'no'}.`);

  for (let index = 0; index < workerCount; index += 1) {
    state.children.set(index, startWorker(index, restartFailed, state));
  }

  process.on('SIGINT', () => stopAllWorkers(state, 'SIGINT'));
  process.on('SIGTERM', () => stopAllWorkers(state, 'SIGTERM'));
}

main();