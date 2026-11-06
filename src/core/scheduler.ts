// Runs due jobs. A job's effects (its replies) and its "done" marker are
// committed together, so a crash before commit simply re-runs the job, and a
// crash after commit can't run it twice. Posting happens later, via the outbox.

import { DateTime } from 'luxon';
import type { Config } from '../config.ts';
import { Effects } from './effects.ts';
import type { Logger } from './log.ts';
import { type JobContext, Registry, jobQueries } from './registry.ts';
import type { Store } from './store.ts';

const MAX_ATTEMPTS = 5;
const BATCH = 20;

export class Scheduler {
  private readonly store: Store;
  private readonly registry: Registry;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly clock: () => Date;

  constructor(store: Store, registry: Registry, config: Config, log: Logger, clock: () => Date = () => new Date()) {
    this.store = store; this.registry = registry; this.config = config; this.log = log; this.clock = clock;
  }

  async tick(): Promise<number> {
    const now = this.clock();
    let ran = 0;
    for (const job of this.store.dueJobs(now, BATCH)) {
      const def = this.registry.job(job.type);
      if (!def) {
        this.store.setJobStatus(job.id, 'failed', now, `no handler for job type ${job.type}`);
        this.log.error('job has no handler', { jobId: job.id, type: job.type });
        continue;
      }
      const effects = new Effects();
      const ctx: JobContext = {
        now: DateTime.fromJSDate(now, { zone: this.config.timezone }),
        config: this.config,
        log: this.log,
        jobs: jobQueries(this.store),
        job,
        payload: JSON.parse(job.payload),
        lateByMs: Math.max(0, now.getTime() - new Date(job.run_at).getTime()),
        reply: (html) => effects.reply(html),
      };
      try {
        await def.run(ctx);
        this.store.tx(() => {
          // Re-check inside the transaction: the job may have been cancelled meanwhile.
          if (this.store.getJob(job.id)?.status !== 'pending') return;
          effects.commit(this.store, job.ticket_id, `job:${job.id}`, now);
          this.store.setJobStatus(job.id, 'done', now);
          this.store.audit('job_done', { ticketId: job.ticket_id, userId: job.created_by, ref: `job:${job.id}` }, now);
        });
        ran++;
        this.log.info('job done', { jobId: job.id, type: job.type, ticketId: job.ticket_id, lateByMs: ctx.lateByMs });
      } catch (e) {
        const msg = (e as Error).message;
        if (job.attempts + 1 >= MAX_ATTEMPTS) {
          this.store.setJobStatus(job.id, 'failed', now, msg);
          this.log.error('job failed permanently', { jobId: job.id, type: job.type, error: msg });
        } else {
          this.store.retryJobLater(job.id, new Date(now.getTime() + 5 * 60_000 * (job.attempts + 1)), now, msg);
          this.log.warn('job failed, will retry', { jobId: job.id, type: job.type, error: msg });
        }
      }
    }
    return ran;
  }
}
