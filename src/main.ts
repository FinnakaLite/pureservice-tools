// Entry point: wires the pieces together and runs three loops:
//   poller (find commands) → scheduler (run due jobs) → outbox (post notes).

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { buildRegistry } from './commands/index.ts';
import { loadConfig } from './config.ts';
import { Dispatcher } from './core/dispatcher.ts';
import { createLogger } from './core/log.ts';
import { Outbox } from './core/outbox.ts';
import { Poller } from './core/poller.ts';
import { Scheduler } from './core/scheduler.ts';
import { Store } from './core/store.ts';
import { createApi } from './pureservice/api.ts';
import { PureServiceClient } from './pureservice/client.ts';

const log = createLogger();
const config = loadConfig();
const store = new Store(config.dbPath);
const owner = `${hostname()}:${process.pid}`;

if (!store.acquireLock(owner, new Date())) {
  log.error('another instance is running against this database — refusing to start', { db: config.dbPath });
  process.exit(1);
}

const client = new PureServiceClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, requestsPerMinute: config.requestsPerMinute, log });
const api = createApi(client);
const registry = buildRegistry();
const dispatcher = new Dispatcher({ store, api, registry, config, log });
const poller = new Poller(store, api, dispatcher, config, log);
const scheduler = new Scheduler(store, registry, config, log);
const outbox = new Outbox(store, api, config, log);

const recovered = store.recoverInFlight(new Date());
if (recovered) log.warn('found notes that were mid-send at last shutdown — they will be verified before any resend', { count: recovered });

log.info('pureservice-tools bot starting', {
  mode: config.writeEnabled ? 'LIVE (posting notes)' : 'DRY-RUN (no notes are posted)',
  api: config.baseUrl,
  db: config.dbPath,
  commands: registry.list().map((c) => c.name),
  allowlist: config.allowedUserIds ? [...config.allowedUserIds] : 'everyone',
  requestsPerMinute: config.requestsPerMinute,
});

// ---------------------------------------------------------------- loops (single-flight)
const timers: NodeJS.Timeout[] = [];
let stopping = false;
function loop(name: string, everySec: number, fn: () => Promise<unknown> | unknown) {
  let running = false;
  const run = async () => {
    if (running || stopping) return;
    running = true;
    try { await fn(); } catch (e) { log.error(`${name} loop crashed`, { error: (e as Error).message }); }
    finally { running = false; }
  };
  timers.push(setInterval(run, everySec * 1000));
  void run();
}

loop('poller', config.pollIntervalSec, () => poller.tick());
loop('scheduler', config.schedulerIntervalSec, () => scheduler.tick());
loop('outbox', config.outboxIntervalSec, () => outbox.tick());
loop('heartbeat', 30, () => {
  if (!store.acquireLock(owner, new Date())) {
    log.error('lost the instance lock to another process — shutting down');
    void shutdown(1);
  }
});
loop('retention', 24 * 3600, () => store.purge(new Date(), config.retentionDays));

// ---------------------------------------------------------------- health endpoint
const server = config.healthPort
  ? createServer((req, res) => {
      if (req.url !== '/healthz') { res.writeHead(404).end(); return; }
      const staleMs = config.pollIntervalSec * 5 * 1000;
      const healthy = !!poller.lastSuccess && Date.now() - poller.lastSuccess.getTime() < staleMs && !client.circuitOpen && !outbox.paused;
      const body = {
        healthy,
        mode: config.writeEnabled ? 'live' : 'dry-run',
        lastPoll: poller.lastSuccess?.toISOString() ?? null,
        lastPollError: poller.lastError,
        cursor: poller.cursor,
        circuitOpen: client.circuitOpen,
        outboxPaused: outbox.paused,
        pendingJobs: store.countJobs('pending'),
        pendingNotes: store.countOutbox('pending'),
        apiRequests: client.requestCount,
      };
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }).listen(config.healthPort, config.healthHost, () => log.info('health endpoint listening', { url: `http://${config.healthHost}:${config.healthPort}/healthz` }))
  : null;

// ---------------------------------------------------------------- shutdown
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down');
  timers.forEach(clearInterval);
  server?.close();
  store.releaseLock(owner);
  store.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
