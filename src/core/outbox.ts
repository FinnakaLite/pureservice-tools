// The single write path to PureService. Every bot note is queued here first,
// then sent within budgets. Dry-run mode (the default) logs instead of posting.
//
// Duplicate protection: each note carries a hidden marker <!-- pst:ob-<id> -->.
// If a POST fails ambiguously (timeout, 5xx) we look for that marker on the
// ticket before ever sending again. If PureService turns out to strip the
// marker, an ambiguous send is marked failed instead of retried — we prefer a
// missed reminder over a duplicate note.

import type { Config } from '../config.ts';
import { ApiError, CircuitOpenError } from '../pureservice/client.ts';
import type { PureServiceApi } from '../pureservice/api.ts';
import { htmlToLines } from './html.ts';
import type { Logger } from './log.ts';
import type { OutboxRow, Store } from './store.ts';

const MAX_VERIFY_ATTEMPTS = 3;
export const marker = (id: number) => `pst:ob-${id}`;

export class Outbox {
  paused = false;
  private readonly store: Store;
  private readonly api: PureServiceApi;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly clock: () => Date;

  constructor(store: Store, api: PureServiceApi, config: Config, log: Logger, clock: () => Date = () => new Date()) {
    this.store = store; this.api = api; this.config = config; this.log = log; this.clock = clock;
  }

  async tick(): Promise<void> {
    const now = this.clock();
    try {
      await this.verifyAmbiguous(now);
      if (!this.config.writeEnabled) return this.dryRun(now);

      const backlog = this.store.countOutbox('pending');
      this.paused = backlog > this.config.outboxBacklogLimit;
      if (this.paused) {
        this.log.error('outbox backlog over limit — writing paused, investigate before raising BOT_OUTBOX_BACKLOG_LIMIT', { backlog });
        return;
      }

      const budget = this.config.notesPerMinute - this.store.sentSince(new Date(now.getTime() - 60_000));
      if (budget <= 0) return;
      for (const row of this.store.outboxByStatus('pending', now, budget)) {
        if (this.store.sentSince(new Date(now.getTime() - 3600_000), row.ticket_id) >= this.config.notesPerTicketPerHour) {
          this.store.setOutbox(row.id, { status: 'pending', notBefore: new Date(now.getTime() + 10 * 60_000) }, now);
          this.log.warn('per-ticket note limit reached — deferring', { outboxId: row.id, ticketId: row.ticket_id });
          continue;
        }
        const keepGoing = await this.send(row, now);
        if (!keepGoing) break;
      }
    } catch (e) {
      if (!(e instanceof CircuitOpenError)) this.log.error('outbox tick failed', { error: (e as Error).message });
    }
  }

  /** Returns false when sending should stop for this tick (PureService unavailable). */
  private async send(row: OutboxRow, now: Date): Promise<boolean> {
    const mark = marker(row.id);
    this.store.setOutbox(row.id, { status: 'sending', bumpAttempts: true }, now);
    try {
      const created = await this.api.createInternalNote(row.ticket_id, `${row.html}<!-- ${mark} -->`);
      this.store.tx(() => {
        this.store.setOutbox(row.id, { status: 'sent', communicationId: created.id }, now);
        if (!this.store.getState('bot_user_id') && created.createdById) this.store.setState('bot_user_id', String(created.createdById));
        if (this.store.getState('marker_survives') === null) this.store.setState('marker_survives', String((created.text ?? '').includes(mark)));
      });
      this.log.info('note posted', { outboxId: row.id, ticketId: row.ticket_id, communicationId: created.id, origin: row.origin });
      return true;
    } catch (e) {
      if (e instanceof CircuitOpenError) {
        this.store.setOutbox(row.id, { status: 'pending' }, now);
        return false;
      }
      const ambiguous = e instanceof ApiError ? e.ambiguous : true;
      this.store.setOutbox(row.id, { status: ambiguous ? 'verify' : 'failed', error: (e as Error).message }, now);
      this.log[ambiguous ? 'warn' : 'error'](ambiguous ? 'note send uncertain — will verify before retrying' : 'note rejected by PureService',
        { outboxId: row.id, ticketId: row.ticket_id, error: (e as Error).message });
      return !ambiguous;
    }
  }

  private async verifyAmbiguous(now: Date) {
    for (const row of this.store.outboxByStatus('verify', now, 5)) {
      const found = await this.api.findBotNote(row.ticket_id, marker(row.id));
      if (found) {
        this.store.setOutbox(row.id, { status: 'sent', communicationId: found.id }, now);
        this.log.info('uncertain send confirmed as delivered', { outboxId: row.id, communicationId: found.id });
      } else if (this.store.getState('marker_survives') !== 'true') {
        this.store.setOutbox(row.id, { status: 'failed', error: 'delivery unknown and marker not verifiable — not resent to avoid duplicates' }, now);
        this.log.error('uncertain send could not be verified — dropped to avoid a duplicate', { outboxId: row.id, ticketId: row.ticket_id });
      } else if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
        this.store.setOutbox(row.id, { status: 'failed', error: 'gave up after repeated uncertain sends' }, now);
        this.log.error('note failed after repeated attempts', { outboxId: row.id, ticketId: row.ticket_id });
      } else {
        this.store.setOutbox(row.id, { status: 'pending', notBefore: new Date(now.getTime() + 60_000) }, now);
      }
    }
  }

  private dryRun(now: Date) {
    for (const row of this.store.outboxByStatus('pending', now, 50)) {
      // Dry-run preview shows the bot's own text so a pilot can check wording and timing.
      this.log.info('[dry-run] would post internal note', {
        outboxId: row.id, ticketId: row.ticket_id, origin: row.origin, preview: htmlToLines(row.html).join(' / ').slice(0, 300),
      });
      this.store.setOutbox(row.id, { status: 'dry_run' }, now);
    }
  }
}
