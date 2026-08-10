/**
 * helpers/enricher/upserter-manager.js
 *
 * Usage:
 *   node helpers/enricher/upserter-manager.js [workerCount]
 *   node helpers/enricher/upserter-manager.js 4 --restart
 *   node helpers/enricher/upserter-manager.js --workers=4 --restart
 */

require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_WORKERS = 4;
const UPSERTER_SCRIPT = path.join(__dirname, 'upserter.js');

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
  const child = spawn(process.execPath, [UPSERTER_SCRIPT], {
    env: {
      ...process.env,
      UPSERTER_MANAGER_WORKER_INDEX: String(index + 1),
      UPSERTER_MANAGER_WORKER_COUNT: String(state.workerCount),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  const prefix = `[slang-worker ${index + 1}/${state.workerCount}]`;

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
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
      console.log('All slang workers have exited.');
      process.exit(state.hadNonRecoverableFailure ? 1 : 0);
    }
  });

  return child;
}

function stopAllWorkers(state, signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  console.log(`\nStopping slang workers due to ${signal}...`);

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

  console.log(`Starting ${workerCount} slang worker(s). Restart failed workers: ${restartFailed ? 'yes' : 'no'}.`);

  for (let index = 0; index < workerCount; index += 1) {
    state.children.set(index, startWorker(index, restartFailed, state));
  }

  process.on('SIGINT', () => stopAllWorkers(state, 'SIGINT'));
  process.on('SIGTERM', () => stopAllWorkers(state, 'SIGTERM'));
}

main();
