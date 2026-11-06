// End-to-end tests of poller → dispatcher → scheduler → outbox against a fake
// PureService and an in-memory database, with a controllable clock.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buildRegistry } from './commands/index.ts';
import { loadConfig, type Config } from './config.ts';
import { Dispatcher } from './core/dispatcher.ts';
import { htmlToLines } from './core/html.ts';
import { silentLogger } from './core/log.ts';
import { Outbox } from './core/outbox.ts';
import { Poller } from './core/poller.ts';
import { Scheduler } from './core/scheduler.ts';
import { Store } from './core/store.ts';
import type { Communication, PureServiceApi, User } from './pureservice/api.ts';
import { ApiError } from './pureservice/client.ts';

const FINN: User = { id: 2611, firstName: 'Finn', lastName: 'McCann', fullName: 'Finn McCann', role: 30, emailAddressId: 2634 };
const OLA: User = { id: 3000, firstName: 'Ola', lastName: 'Nordmann', fullName: 'Ola Nordmann', role: 20, emailAddressId: 3001 };
const BOT: User = { id: 2695, firstName: 'Pureservice-tools-test', lastName: '', fullName: 'Pureservice-tools-test', role: 50, emailAddressId: null };

class FakePureService implements PureServiceApi {
  notes: Communication[] = [];
  posted: { ticketId: number; html: string; id: number }[] = [];
  users = new Map<number, User>([[FINN.id, FINN], [OLA.id, OLA], [BOT.id, BOT]]);
  nextId = 1000;
  failNextPost: ApiError | null = null;
  stripMarker = false;
  clock: () => Date = () => new Date();

  add(text: string, by: User = FINN, opts: Partial<Communication> = {}): Communication {
    const ts = this.clock().toISOString();
    const c: Communication = { id: ++this.nextId, type: 1, direction: 3, visibility: 0, text, ticketId: 500, createdById: by.id,
      created: ts, modified: ts, ...opts };
    this.notes.push(c);
    return c;
  }
  async newestNoteId() { return this.notes.at(-1)?.id ?? null; }
  async notesAfter(afterId: number, limit: number) {
    const notes = this.notes.filter((n) => n.type === 1 && n.id > afterId && (n.text ?? '').includes('!')).slice(0, limit);
    return { notes, users: this.users };
  }
  async findBotNote(ticketId: number, marker: string) {
    return this.notes.find((n) => n.ticketId === ticketId && (n.text ?? '').includes(marker)) ?? null;
  }
  async createInternalNote(ticketId: number, html: string) {
    const stored = this.stripMarker ? html.replace(/<!--[\s\S]*?-->/g, '') : html;
    const c = this.add(stored, BOT, { ticketId });
    if (this.failNextPost) { const e = this.failNextPost; this.failNextPost = null; throw e; }
    this.posted.push({ ticketId, html: stored, id: c.id });
    return c;
  }
  async userEmail(u: User) { return u.id === FINN.id ? 'finn.mccann@smith.no' : null; }
}

function setup(overrides: Partial<Config> = {}) {
  const config: Config = {
    ...loadConfig({ PS_BASE_URL: 'https://example.pureservice.com', PS_API_KEY: 'x' }),
    writeEnabled: true,
    ...overrides,
  };
  let now = new Date('2026-11-06T09:05:00Z'); // 10:05 Oslo
  const clock = () => now;
  const store = new Store(':memory:');
  const api = new FakePureService();
  api.clock = clock;
  const registry = buildRegistry();
  const dispatcher = new Dispatcher({ store, api, registry, config, log: silentLogger, clock });
  const poller = new Poller(store, api, dispatcher, config, silentLogger);
  const scheduler = new Scheduler(store, registry, config, silentLogger, clock);
  const outbox = new Outbox(store, api, config, silentLogger, clock);
  const advance = (ms: number) => { now = new Date(now.getTime() + ms); };
  const cycle = async () => { await poller.tick(); await scheduler.tick(); await outbox.tick(); };
  return { config, store, api, poller, scheduler, outbox, advance, cycle };
}

const text = (html: string) => htmlToLines(html).join(' / ');

describe('bot end-to-end', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('does not replay notes that existed before the first start', async () => {
    t.api.add('<p>!remindme 1d</p>');
    await t.cycle();
    assert.equal(t.api.posted.length, 0);
  });

  it('schedules a reminder, confirms it, and fires it with a mention at the right time', async () => {
    await t.cycle(); // initialise cursor
    t.api.add('<p>!remindme 10d 08:00 ring leverandør</p>');
    await t.cycle();

    assert.equal(t.api.posted.length, 1, 'one confirmation note');
    const confirm = text(t.api.posted[0]!.html);
    assert.match(confirm, /^🤖 ⏰ Påminnelse R-1 satt til mandag 16\. november 2026 kl\. 08:00 \(om 10 dager\)/);
    assert.match(confirm, /ring leverandør/);
    assert.match(t.api.posted[0]!.html, /<!-- pst:ob-\d+ -->$/, 'carries the duplicate-protection marker');

    t.advance(9 * 86400_000); await t.cycle();
    assert.equal(t.api.posted.length, 1, 'nothing fires early');

    t.advance(2 * 86400_000); await t.cycle();
    assert.equal(t.api.posted.length, 2, 'reminder fired');
    const fired = t.api.posted[1]!.html;
    assert.match(fired, /data-mention-user-id="2611"/);
    assert.match(fired, /href="mailto:finn\.mccann@smith\.no"/);
    assert.match(text(fired), /^🤖 🔔 @Finn McCann påminnelse R-1: «ring leverandør»/);

    t.advance(86400_000); await t.cycle();
    assert.equal(t.api.posted.length, 2, 'fires exactly once');
  });

  it('never reacts to its own notes, even though they quote commands', async () => {
    await t.cycle();
    t.api.add('<p>!help</p>');
    await t.cycle();
    assert.equal(t.api.posted.length, 1);
    for (let i = 0; i < 3; i++) await t.cycle();
    assert.equal(t.api.posted.length, 1, 'help reply did not trigger anything');
    assert.equal(t.store.getState('bot_user_id'), String(BOT.id), 'learned its own user id from the first post');
  });

  it('ignores system users, unknown commands, mid-line commands and non-notes', async () => {
    await t.cycle();
    t.api.add('<p>!remindme 1d</p>', BOT);
    t.api.add('<p>!dothething now</p>');
    t.api.add('<p>Husk !remindme 1d</p>');
    t.api.add('<p>!remindme 1d</p>', FINN, { type: 2 }); // a Message to the end user
    await t.cycle();
    assert.equal(t.api.posted.length, 0);
  });

  it('processes each note once despite the cursor overlap', async () => {
    await t.cycle();
    t.api.add('<p>!remindme 1d</p>');
    for (let i = 0; i < 5; i++) await t.cycle();
    assert.equal(t.api.posted.length, 1);
    assert.equal(t.store.countJobs('pending'), 1);
  });

  it('replies once with help on an unparseable time', async () => {
    await t.cycle();
    t.api.add('<p>!remindme sometime soon</p>');
    await t.cycle();
    assert.equal(t.api.posted.length, 1);
    assert.match(text(t.api.posted[0]!.html), /Forstod ikke tidspunktet «sometime»/);
    assert.equal(t.store.countJobs('pending'), 0);
  });

  it('lists and cancels reminders; only the owner can cancel', async () => {
    await t.cycle();
    t.api.add('<p>!remindme 2d første</p>');
    t.api.add('<p>!remindme 3d andre</p>');
    await t.cycle();
    t.api.add('<p>!reminders</p>');
    await t.cycle();
    assert.match(text(t.api.posted.at(-1)!.html), /R-1 .*første.*R-2 .*andre/);

    t.api.add('<p>!remindme cancel R-1</p>', OLA);
    await t.cycle();
    assert.match(text(t.api.posted.at(-1)!.html), /Fant ingen påminnelse R-1 som tilhører deg/);

    t.api.add('<p>!remindme cancel r-1</p>');
    await t.cycle();
    assert.match(text(t.api.posted.at(-1)!.html), /R-1 er avbrutt/);

    const before = t.api.posted.length;
    t.advance(4 * 86400_000); await t.cycle();
    const fired = t.api.posted.slice(before).map((p) => text(p.html));
    assert.equal(fired.length, 1, 'only R-2 fires');
    assert.match(fired[0]!, /R-2/);
  });

  it('dry-run mode posts nothing', async () => {
    t = setup({ writeEnabled: false });
    await t.cycle();
    t.api.add('<p>!remindme 1m</p>');
    await t.cycle();
    t.advance(120_000); await t.cycle();
    assert.equal(t.api.posted.length, 0);
    assert.equal(t.store.countOutbox('dry_run'), 2);
  });

  it('pilot allowlist: other users are ignored silently', async () => {
    t = setup({ allowedUserIds: new Set([FINN.id]) });
    await t.cycle();
    t.api.add('<p>!remindme 1d</p>', OLA);
    await t.cycle();
    assert.equal(t.api.posted.length, 0);
  });

  it('per-ticket budget defers notes instead of flooding a ticket', async () => {
    t = setup({ notesPerTicketPerHour: 2, commandsPerUserPerHour: 100 });
    await t.cycle();
    for (let i = 0; i < 4; i++) t.api.add('<p>!reminders</p>');
    await t.cycle();
    assert.equal(t.api.posted.length, 2);
    t.advance(61 * 60_000); await t.cycle();
    assert.equal(t.api.posted.length, 4);
  });

  it('per-user command limit', async () => {
    t = setup({ commandsPerUserPerHour: 2 });
    await t.cycle();
    for (let i = 0; i < 4; i++) t.api.add('<p>!reminders</p>');
    await t.cycle();
    assert.equal(t.api.posted.length, 2);
  });

  it('a timed-out POST that actually landed is not sent twice', async () => {
    await t.cycle();
    t.store.setState('marker_survives', 'true');
    t.api.failNextPost = new ApiError('timeout', 0, true);
    t.api.add('<p>!reminders</p>');
    await t.cycle();             // POST "fails" but the note exists
    await t.cycle();             // verify finds the marker
    assert.equal(t.store.countOutbox('sent'), 1);
    const botNotes = t.api.notes.filter((n) => n.createdById === BOT.id);
    assert.equal(botNotes.length, 1, 'exactly one note on the ticket');
  });

  it('if the marker cannot be verified, an uncertain send is dropped rather than duplicated', async () => {
    t.api.stripMarker = true;
    await t.cycle();
    t.api.failNextPost = new ApiError('timeout', 0, true);
    t.api.add('<p>!reminders</p>');
    await t.cycle(); await t.cycle();
    assert.equal(t.store.countOutbox('failed'), 1);
    assert.equal(t.api.notes.filter((n) => n.createdById === BOT.id).length, 1);
  });

  it('durations count from when the note was written, not when the bot saw it', async () => {
    await t.cycle();
    t.api.add('<p>!remindme 1d</p>');      // written 10:05
    t.advance(3 * 3600_000);                // bot was down; processes it at 13:05
    await t.cycle();
    assert.match(text(t.api.posted[0]!.html), /lørdag 7\. november 2026 kl\. 10:05 \(om 21 timer\)/);
  });

  it('a reminder that fires late says so', async () => {
    await t.cycle();
    t.api.add('<p>!remindme 1h</p>');
    await t.cycle();
    t.advance(5 * 3600_000); await t.cycle(); // bot was "down" for 4 extra hours
    assert.match(text(t.api.posted.at(-1)!.html), /Forsinket – skulle vært sendt/);
  });
});
