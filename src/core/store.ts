// SQLite persistence (Node's built-in node:sqlite). All times are UTC ISO strings,
// which sort correctly as text. Every write that belongs together is committed in
// one synchronous transaction, so a crash can never leave half an action behind.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE processed_notes (
     communication_id INTEGER PRIMARY KEY,
     ticket_id INTEGER NOT NULL,
     author_id INTEGER,
     commands TEXT,
     outcome TEXT NOT NULL,
     processed_at TEXT NOT NULL);
   CREATE INDEX processed_by_author ON processed_notes(author_id, processed_at);
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY,
     type TEXT NOT NULL,
     run_at TEXT NOT NULL,
     status TEXT NOT NULL,              -- pending | done | failed | cancelled
     payload TEXT NOT NULL,
     ticket_id INTEGER NOT NULL,
     created_by INTEGER,
     source_communication_id INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE INDEX jobs_due ON jobs(status, run_at);
   CREATE INDEX jobs_by_user ON jobs(created_by, status);
   CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL,
     html TEXT NOT NULL,
     status TEXT NOT NULL,              -- pending | sending | verify | sent | dry_run | failed
     origin TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     not_before TEXT NOT NULL,
     communication_id INTEGER,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE INDEX outbox_status ON outbox(status, not_before);
   CREATE INDEX outbox_ticket ON outbox(ticket_id, status, updated_at);
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     action TEXT NOT NULL,
     ticket_id INTEGER,
     user_id INTEGER,
     ref TEXT,
     detail TEXT);`,
];

export type JobStatus = 'pending' | 'done' | 'failed' | 'cancelled';
export type OutboxStatus = 'pending' | 'sending' | 'verify' | 'sent' | 'dry_run' | 'failed';

export interface JobRow {
  id: number;
  type: string;
  run_at: string;
  status: JobStatus;
  payload: string;
  ticket_id: number;
  created_by: number | null;
  source_communication_id: number | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface OutboxRow {
  id: number;
  ticket_id: number;
  html: string;
  status: OutboxStatus;
  origin: string | null;
  attempts: number;
  not_before: string;
  communication_id: number | null;
  created_at: string;
}

export interface NewJob {
  id: number;
  type: string;
  runAt: Date;
  payload: unknown;
  ticketId: number;
  createdBy: number | null;
  sourceCommunicationId: number | null;
}

export interface NewReply {
  ticketId: number;
  html: string;
  origin: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      });
      version++;
    }
  }

  /** Synchronous transaction. Never put an `await` inside `fn`. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() { this.db.close(); }

  // ---------------------------------------------------------------- state
  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setState(key: string, value: string) {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  /** Ids are allocated (and committed) up front so a command can show "R-12" in its reply. */
  allocateJobId(): number {
    return this.tx(() => {
      const cur = Number(this.getState('next_job_id') ?? '1');
      this.setState('next_job_id', String(cur + 1));
      return cur;
    });
  }

  // ---------------------------------------------------------------- processed notes
  isProcessed(communicationId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM processed_notes WHERE communication_id = ?').get(communicationId);
  }
  markProcessed(n: { communicationId: number; ticketId: number; authorId: number | null; commands: string[]; outcome: string }, now: Date) {
    this.db.prepare(`INSERT OR IGNORE INTO processed_notes (communication_id, ticket_id, author_id, commands, outcome, processed_at)
                     VALUES (?, ?, ?, ?, ?, ?)`).run(n.communicationId, n.ticketId, n.authorId, n.commands.join(','), n.outcome, now.toISOString());
  }
  commandsByUserSince(authorId: number, since: Date): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM processed_notes WHERE author_id = ? AND processed_at > ? AND outcome = 'ok'`)
      .get(authorId, since.toISOString()) as { n: number };
    return r.n;
  }

  // ---------------------------------------------------------------- jobs
  insertJob(j: NewJob, now: Date) {
    this.db.prepare(`INSERT INTO jobs (id, type, run_at, status, payload, ticket_id, created_by, source_communication_id, created_at, updated_at)
                     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
      .run(j.id, j.type, j.runAt.toISOString(), JSON.stringify(j.payload), j.ticketId, j.createdBy, j.sourceCommunicationId, now.toISOString(), now.toISOString());
  }
  getJob(id: number): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined) ?? null;
  }
  dueJobs(now: Date, limit: number): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?`)
      .all(now.toISOString(), limit) as unknown as JobRow[];
  }
  activeJobs(filter: { type?: string; createdBy?: number; ticketId?: number }): JobRow[] {
    const where = [`status = 'pending'`];
    const args: (string | number)[] = [];
    if (filter.type) { where.push('type = ?'); args.push(filter.type); }
    if (filter.createdBy !== undefined) { where.push('created_by = ?'); args.push(filter.createdBy); }
    if (filter.ticketId !== undefined) { where.push('ticket_id = ?'); args.push(filter.ticketId); }
    return this.db.prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY run_at`).all(...args) as unknown as JobRow[];
  }
  setJobStatus(id: number, status: JobStatus, now: Date, error?: string) {
    this.db.prepare('UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, error ?? null, now.toISOString(), id);
  }
  cancelJob(id: number, now: Date): boolean {
    const r = this.db.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`).run(now.toISOString(), id);
    return Number(r.changes) > 0;
  }
  retryJobLater(id: number, runAt: Date, now: Date, error: string) {
    this.db.prepare('UPDATE jobs SET attempts = attempts + 1, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(runAt.toISOString(), error, now.toISOString(), id);
  }
  countJobs(status: JobStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status = ?').get(status) as { n: number }).n;
  }

  // ---------------------------------------------------------------- outbox
  enqueueReply(r: NewReply, now: Date): number {
    const res = this.db.prepare(`INSERT INTO outbox (ticket_id, html, status, origin, not_before, created_at, updated_at)
                                 VALUES (?, ?, 'pending', ?, ?, ?, ?)`)
      .run(r.ticketId, r.html, r.origin, now.toISOString(), now.toISOString(), now.toISOString());
    return Number(res.lastInsertRowid);
  }
  outboxByStatus(status: OutboxStatus, now: Date, limit: number): OutboxRow[] {
    return this.db.prepare('SELECT * FROM outbox WHERE status = ? AND not_before <= ? ORDER BY id LIMIT ?')
      .all(status, now.toISOString(), limit) as unknown as OutboxRow[];
  }
  setOutbox(id: number, fields: { status: OutboxStatus; communicationId?: number | null; error?: string | null; notBefore?: Date; bumpAttempts?: boolean }, now: Date) {
    this.db.prepare(`UPDATE outbox SET status = ?, communication_id = COALESCE(?, communication_id), last_error = ?,
                       not_before = COALESCE(?, not_before), attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .run(fields.status, fields.communicationId ?? null, fields.error ?? null, fields.notBefore?.toISOString() ?? null,
           fields.bumpAttempts ? 1 : 0, now.toISOString(), id);
  }
  countOutbox(status: OutboxStatus): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status) as { n: number }).n;
  }
  sentSince(since: Date, ticketId?: number): number {
    const sql = `SELECT COUNT(*) AS n FROM outbox WHERE status IN ('sent','sending','verify') AND updated_at > ?` + (ticketId !== undefined ? ' AND ticket_id = ?' : '');
    const args: (string | number)[] = [since.toISOString()];
    if (ticketId !== undefined) args.push(ticketId);
    return (this.db.prepare(sql).get(...args) as { n: number }).n;
  }
  /** After a crash, anything mid-send must be verified before it may be sent again. */
  recoverInFlight(now: Date): number {
    return Number(this.db.prepare(`UPDATE outbox SET status = 'verify', updated_at = ? WHERE status = 'sending'`).run(now.toISOString()).changes);
  }

  // ---------------------------------------------------------------- audit + retention
  audit(action: string, fields: { ticketId?: number | null; userId?: number | null; ref?: string | null; detail?: string | null }, now: Date) {
    this.db.prepare('INSERT INTO audit_log (ts, action, ticket_id, user_id, ref, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now.toISOString(), action, fields.ticketId ?? null, fields.userId ?? null, fields.ref ?? null, fields.detail ?? null);
  }
  purge(now: Date, retentionDays: number) {
    const cutoff = new Date(now.getTime() - retentionDays * 86400_000).toISOString();
    const jobCutoff = new Date(now.getTime() - 365 * 86400_000).toISOString();
    this.tx(() => {
      this.db.prepare('DELETE FROM processed_notes WHERE processed_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
      this.db.prepare(`DELETE FROM outbox WHERE status IN ('sent','dry_run','failed') AND updated_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND updated_at < ?`).run(jobCutoff);
    });
  }

  // ---------------------------------------------------------------- single-instance lock
  /** Returns false if another live instance holds the lock (heartbeat < 2 min old). */
  acquireLock(owner: string, now: Date): boolean {
    return this.tx(() => {
      const raw = this.getState('instance_lock');
      if (raw) {
        const lock = JSON.parse(raw) as { owner: string; heartbeat: string };
        const fresh = now.getTime() - new Date(lock.heartbeat).getTime() < 120_000;
        if (fresh && lock.owner !== owner) return false;
      }
      this.setState('instance_lock', JSON.stringify({ owner, heartbeat: now.toISOString() }));
      return true;
    });
  }
  releaseLock(owner: string) {
    const raw = this.getState('instance_lock');
    if (raw && (JSON.parse(raw) as { owner: string }).owner === owner) this.db.prepare(`DELETE FROM state WHERE key = 'instance_lock'`).run();
  }
}
