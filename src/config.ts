// All settings come from environment variables (see .env.example).
// Defaults are deliberately safe: dry-run on, conservative budgets.

export interface Config {
  baseUrl: string;            // https://{customer}.pureservice.com/agent/api
  apiKey: string;
  dbPath: string;
  writeEnabled: boolean;      // false = dry-run: parse/log everything, post nothing
  timezone: string;
  defaultTime: { hour: number; minute: number }; // used when a date is given without a time
  pollIntervalSec: number;
  schedulerIntervalSec: number;
  outboxIntervalSec: number;
  requestsPerMinute: number;  // hard ceiling for ALL API traffic from this process
  notesPerMinute: number;     // global ceiling for notes the bot posts
  notesPerTicketPerHour: number;
  commandsPerUserPerHour: number;
  maxCommandsPerNote: number;
  outboxBacklogLimit: number; // pause writing if this many notes are waiting
  cursorOverlap: number;      // re-read this many ids below the cursor each poll
  startFromId: number | null; // first start only; default = newest note (no backfill)
  botUserId: number | null;   // the API key's user; learned automatically if unset
  allowedUserIds: Set<number> | null; // pilot allowlist; null = everyone
  healthPort: number;         // 0 disables
  retentionDays: number;
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

function optInt(name: string): number | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? null : int(name, 0, 1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawBase = (env.PS_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const apiKey = (env.PS_API_KEY ?? '').trim();
  if (!rawBase) throw new Error('PS_BASE_URL is required, e.g. https://smith.pureservice.com');
  if (!apiKey) throw new Error('PS_API_KEY is required');
  const baseUrl = rawBase.endsWith('/agent/api') ? rawBase : `${rawBase}/agent/api`;

  const [h = '8', m = '0'] = (env.BOT_DEFAULT_TIME ?? '08:00').split(':');
  const allowed = (env.BOT_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (allowed.some((n) => !Number.isInteger(n))) throw new Error('BOT_ALLOWED_USER_IDS must be a comma-separated list of user ids');

  return {
    baseUrl,
    apiKey,
    dbPath: env.BOT_DB_PATH?.trim() || 'data/bot.db',
    writeEnabled: env.BOT_WRITE_ENABLED?.trim().toLowerCase() === 'true',
    timezone: env.BOT_TIMEZONE?.trim() || 'Europe/Oslo',
    defaultTime: { hour: Number(h), minute: Number(m) },
    pollIntervalSec: int('BOT_POLL_INTERVAL_SEC', 30, 5),
    schedulerIntervalSec: int('BOT_SCHEDULER_INTERVAL_SEC', 15, 1),
    outboxIntervalSec: int('BOT_OUTBOX_INTERVAL_SEC', 5, 1),
    requestsPerMinute: int('BOT_REQUESTS_PER_MINUTE', 40, 1),
    notesPerMinute: int('BOT_NOTES_PER_MINUTE', 20, 1),
    notesPerTicketPerHour: int('BOT_NOTES_PER_TICKET_PER_HOUR', 5, 1),
    commandsPerUserPerHour: int('BOT_COMMANDS_PER_USER_PER_HOUR', 20, 1),
    maxCommandsPerNote: int('BOT_MAX_COMMANDS_PER_NOTE', 3, 1),
    outboxBacklogLimit: int('BOT_OUTBOX_BACKLOG_LIMIT', 200, 1),
    cursorOverlap: int('BOT_CURSOR_OVERLAP', 50, 0),
    startFromId: optInt('BOT_START_FROM_ID'),
    botUserId: optInt('BOT_USER_ID'),
    allowedUserIds: allowed.length ? new Set(allowed) : null,
    healthPort: int('BOT_HEALTH_PORT', 8080, 0),
    retentionDays: int('BOT_RETENTION_DAYS', 90, 1),
  };
}
