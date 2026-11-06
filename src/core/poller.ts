// Finds new internal notes using an integer id cursor (verified in the spike:
// ids increase with creation time). Each poll re-reads a small overlap below the
// cursor in case a lower id committed late; processed_notes de-duplicates it.

import type { Config } from '../config.ts';
import type { PureServiceApi } from '../pureservice/api.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Logger } from './log.ts';
import type { Store } from './store.ts';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_TICK = 5;

export class Poller {
  lastSuccess: Date | null = null;
  lastError: string | null = null;
  private readonly store: Store;
  private readonly api: PureServiceApi;
  private readonly dispatcher: Dispatcher;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(store: Store, api: PureServiceApi, dispatcher: Dispatcher, config: Config, log: Logger) {
    this.store = store; this.api = api; this.dispatcher = dispatcher; this.config = config; this.log = log;
  }

  get cursor(): number | null {
    const v = this.store.getState('cursor');
    return v === null ? null : Number(v);
  }

  /**
   * First start: begin at the newest existing note, so old commands are never replayed.
   * That id is also stored as a permanent floor the overlap re-read may never go below.
   */
  async ensureCursor(): Promise<number> {
    const existing = this.cursor;
    if (existing !== null) return existing;
    const start = this.config.startFromId ?? (await this.api.newestNoteId()) ?? 0;
    this.store.tx(() => {
      this.store.setState('cursor', String(start));
      this.store.setState('cursor_floor', String(start));
    });
    this.log.info('cursor initialised — older notes will not be processed', { cursor: start });
    return start;
  }

  async tick(): Promise<void> {
    try {
      let cursor = await this.ensureCursor();
      const floor = Number(this.store.getState('cursor_floor') ?? '0');
      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        const { notes, users } = await this.api.notesAfter(Math.max(floor, cursor - this.config.cursorOverlap), PAGE_SIZE);
        for (const note of notes) {
          const outcome = await this.dispatcher.handle(note, users); // throws → stop; same note is retried next tick
          if (outcome !== 'duplicate' && outcome !== 'no_command') this.log.debug('note', { id: note.id, outcome });
          if (note.id > cursor) {
            cursor = note.id;
            this.store.setState('cursor', String(cursor));
          }
        }
        if (notes.length < PAGE_SIZE) break;
      }
      this.lastSuccess = new Date();
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log.warn('poll failed', { error: this.lastError });
    }
  }
}
