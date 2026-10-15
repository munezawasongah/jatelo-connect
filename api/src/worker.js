// Jatelo Connect background worker. Runs as its own container from the API image:
//   node src/worker.js
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { config } from './config.js';
import { closePools } from './db.js';
import { migrate } from './migrate.js';
import * as jobs from './jobs.js';

const log = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });

// name, function, interval in seconds
export const SCHEDULE = [
  ['sms', jobs.sendQueuedSms, 5],
  ['expiries', jobs.processExpiries, 30],
  ['exhausted', jobs.cutExhausted, 60],
  ['payments-expire', jobs.expirePendingPayments, 60],
  ['router-health', jobs.checkRouterHealth, 60],
  ['traffic', jobs.sampleTraffic, 60],
  ['router-info', jobs.refreshRouterInfo, 300],
  ['stale-sessions', jobs.closeStaleSessions, 300],
  ['reminders', jobs.sendReminders, 900],
  ['unmatched', jobs.flagUnmatchedPayments, 1800],
  ['tenant-status', jobs.updateTenantStatuses, 3600],
  ['housekeeping', jobs.housekeeping, 21600],
];

function start() {
  const timers = [];
  for (const [name, fn, every] of SCHEDULE) {
    let running = false;
    const tick = async () => {
      if (running) return; // never overlap the same job
      running = true;
      const t0 = Date.now();
      try {
        const n = await fn(log);
        if (n) log.debug({ job: name, n, ms: Date.now() - t0 }, 'job done');
      } catch (e) {
        log.error({ job: name, err: e.message }, 'job failed');
      } finally {
        running = false;
      }
    };
    // Stagger first runs so they do not all hit the database at boot
    timers.push(setTimeout(() => { tick(); timers.push(setInterval(tick, every * 1000)); }, Math.random() * 5000));
  }
  return timers;
}

async function main() {
  await migrate(config.DATABASE_OWNER_URL, log);
  log.info('Jatelo Connect worker started');
  const timers = start();
  const stop = () => {
    log.info('worker stopping');
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    closePools().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { log.fatal(e); process.exit(1); });
}
