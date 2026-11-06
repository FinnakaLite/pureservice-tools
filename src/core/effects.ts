// Commands and jobs don't write anything directly. They collect "effects"
// (replies, new jobs, cancellations) which are committed in ONE synchronous
// SQLite transaction together with the processed/done marker. Either all of it
// happens or none of it — so a crash can't produce a reply without the job,
// or run the same command twice.

import { commandLines } from './html.ts';
import type { NewJob, Store } from './store.ts';

export const BOT_PREFIX = '🤖';

export class Effects {
  readonly replies: string[] = [];
  readonly jobs: NewJob[] = [];
  readonly cancels: number[] = [];

  reply(html: string) {
    const note = formatBotNote(html);
    // Defence in depth: a bot note must never contain something the bot itself would execute.
    if (commandLines(note).length) throw new Error('Bot reply contains a !command at line start — wrap it in <code>');
    this.replies.push(note);
  }

  commit(store: Store, ticketId: number, origin: string, now: Date) {
    for (const j of this.jobs) store.insertJob(j, now);
    for (const id of this.cancels) store.cancelJob(id, now);
    for (const html of this.replies) store.enqueueReply({ ticketId, html, origin }, now);
  }
}

/** Ensures every bot note starts with the 🤖 marker and is wrapped in a paragraph. */
export function formatBotNote(html: string): string {
  const trimmed = html.trim();
  if (/^<p\b[^>]*>/i.test(trimmed)) return trimmed.replace(/^<p\b[^>]*>/i, (m) => `${m}${BOT_PREFIX} `);
  return `<p>${BOT_PREFIX} ${trimmed}</p>`;
}
