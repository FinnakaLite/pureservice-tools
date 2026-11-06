// Decides whether a note is a command for the bot, and runs it.
// Every guard here exists to stop the bot from acting on notes not meant for it.

import { DateTime } from 'luxon';
import type { Config } from '../config.ts';
import { type Communication, type PureServiceApi, type User, UserRole } from '../pureservice/api.ts';
import { Effects, BOT_PREFIX } from './effects.ts';
import { commandLines, htmlToLines } from './html.ts';
import type { Logger } from './log.ts';
import { type CommandContext, type NoteAuthor, type NoteEvent, Registry, jobQueries } from './registry.ts';
import type { Store } from './store.ts';

export type Outcome =
  | 'duplicate' | 'own_note' | 'system_author' | 'no_command' | 'not_allowed'
  | 'rate_limited' | 'unknown_author' | 'ok';

export interface DispatcherDeps {
  store: Store;
  api: PureServiceApi;
  registry: Registry;
  config: Config;
  log: Logger;
  clock?: () => Date;
}

export class Dispatcher {
  private readonly d: DispatcherDeps;
  constructor(deps: DispatcherDeps) { this.d = deps; }

  private now(): Date { return this.d.clock?.() ?? new Date(); }

  botUserId(): number | null {
    return this.d.config.botUserId ?? (Number(this.d.store.getState('bot_user_id')) || null);
  }

  /**
   * Handles one note. Throws only on transient failures (e.g. PureService down),
   * in which case nothing was recorded and the poller retries the same note later.
   */
  async handle(c: Communication, users: Map<number, User>): Promise<Outcome> {
    const { store, registry, config, log } = this.d;
    const now = this.now();
    const ticketId = c.ticketId;
    if (store.isProcessed(c.id)) return 'duplicate';
    if (!ticketId) return 'no_command'; // notes on changes etc. — not supported (yet)

    const record = (outcome: Outcome, commands: string[] = []) => {
      store.markProcessed({ communicationId: c.id, ticketId, authorId: c.createdById ?? null, commands, outcome }, now);
      return outcome;
    };

    const html = c.text ?? '';
    const user = users.get(c.createdById);

    // 1. Never react to ourselves (by id, by role, and by the 🤖 marker).
    if (c.createdById === this.botUserId()) return record('own_note');
    if (user?.role === UserRole.System) return record('system_author');
    if (htmlToLines(html)[0]?.startsWith(BOT_PREFIX)) return record('own_note');

    // 2. Only "!<registered command>" at the start of a line counts. Unknown !words are ignored silently.
    const cmds = commandLines(html).filter((x) => registry.command(x.name)).slice(0, config.maxCommandsPerNote);
    if (!cmds.length) return record('no_command');
    const names = cmds.map((x) => x.name);

    // 3. Pilot allowlist and per-user rate limit.
    if (config.allowedUserIds && !config.allowedUserIds.has(c.createdById)) return record('not_allowed', names);
    if (store.commandsByUserSince(c.createdById, new Date(now.getTime() - 3600_000)) >= config.commandsPerUserPerHour) {
      log.warn('per-user command limit reached', { userId: c.createdById, communicationId: c.id });
      return record('rate_limited', names);
    }
    if (!user) return record('unknown_author', names);

    // 4. Resolve the author (one cached lookup for the e-mail used in mentions). May throw → retried later.
    const author: NoteAuthor = {
      id: user.id,
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      fullName: user.fullName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
      role: user.role,
      email: await this.d.api.userEmail(user),
    };
    const note: NoteEvent = {
      communicationId: c.id,
      ticketId,
      author,
      html,
      created: DateTime.fromISO(c.created, { zone: config.timezone }),
    };

    // 5. Run the commands, collecting effects.
    const effects = new Effects();
    for (const cmd of cmds) {
      const def = registry.command(cmd.name)!;
      const ctx = this.context(note, effects, now);
      try {
        await def.run(ctx, cmd.args);
      } catch (e) {
        log.error('command failed', { command: def.name, communicationId: c.id, ticketId, error: (e as Error).message });
        try { effects.reply(`Noe gikk galt med <code>!${def.name}</code>. Prøv igjen, eller si fra til IT.`); } catch { /* ignore */ }
      }
    }

    // 6. Commit everything atomically.
    store.tx(() => {
      effects.commit(store, ticketId, `note:${c.id}`, now);
      record('ok', names);
      store.audit('command', { ticketId, userId: author.id, ref: `note:${c.id}`, detail: names.join(',') }, now);
    });
    log.info('command handled', { communicationId: c.id, ticketId, userId: author.id, commands: names, replies: effects.replies.length, jobs: effects.jobs.length });
    return 'ok';
  }

  private context(note: NoteEvent, effects: Effects, now: Date): CommandContext {
    const { store, config, log } = this.d;
    return {
      now: DateTime.fromJSDate(now, { zone: config.timezone }),
      config,
      log,
      note,
      jobs: jobQueries(store),
      reply: (html) => effects.reply(html),
      schedule: (type, runAt, payload) => {
        if (!this.d.registry.job(type)) throw new Error(`Unknown job type "${type}"`);
        const id = store.allocateJobId();
        effects.jobs.push({ id, type, runAt: runAt.toJSDate(), payload, ticketId: note.ticketId, createdBy: note.author.id, sourceCommunicationId: note.communicationId });
        return id;
      },
      cancelJob: (id) => { effects.cancels.push(id); },
    };
  }
}
