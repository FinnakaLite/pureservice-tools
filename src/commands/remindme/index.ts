// !remindme — tag the author on this ticket at a later time.
//
//   !remindme <when> [message]     schedule (see parse.ts for <when>)
//   !remindme list                 your active reminders on this ticket   (also: !reminders)
//   !remindme cancel R-12          cancel one of your reminders

import { DateTime } from 'luxon';
import { escapeHtml, mentionHtml } from '../../core/html.ts';
import { type CommandContext, defineCommand, defineJob } from '../../core/registry.ts';
import type { JobRow } from '../../core/store.ts';
import { parseWhen, type WhenError } from './parse.ts';

export const JOB_TYPE = 'remindme.fire';
const MAX_ACTIVE_PER_USER = 100;
const LATE_NOTICE_MS = 60 * 60_000;

export interface ReminderPayload {
  userId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  message: string;
  setAt: string; // ISO
}

const ref = (id: number) => `R-${id}`;

/** "om 10 dager" / "om 3 timer" / "om 25 minutter" (Luxon's nb locale says "døgn"). */
export function relative(at: DateTime, now: DateTime): string {
  const min = Math.round(at.diff(now, 'minutes').minutes);
  if (min <= 0) return 'forfalt – sendes straks';
  const plural = (n: number, one: string, many: string) => `om ${n} ${n === 1 ? one : many}`;
  if (min < 60) return plural(min, 'minutt', 'minutter');
  if (min < 48 * 60) {
    const h = Math.floor(min / 60), m = min % 60;
    return plural(h, 'time', 'timer') + (m && h < 6 ? ` og ${m} min` : '');
  }
  return plural(Math.round(min / 1440), 'dag', 'dager');
}
const long = (d: DateTime) => d.setLocale('nb').toFormat("cccc d. LLLL yyyy 'kl.' HH:mm");
const short = (d: DateTime) => d.setLocale('nb').toFormat("ccc d.MM.yyyy 'kl.' HH:mm");

const EXAMPLES = ['remindme 10d', 'remindme 2t30m sjekk backup', 'remindme 10d 08:00', 'remindme fredag kl 9 ring leverandør', 'remindme 24.12 0800'];
const examplesHtml = () => EXAMPLES.map((e) => `<code>!${e}</code>`).join(' · ');

const ERRORS: Record<WhenError, (token?: string) => string> = {
  empty: () => `Når vil du bli minnet på? Eksempler: ${examplesHtml()}`,
  unparsed: (t) => `Forstod ikke tidspunktet${t ? ` «${escapeHtml(t)}»` : ''}. Eksempler: ${examplesHtml()}`,
  invalid_time: (t) => `«${escapeHtml(t ?? '')}» er ikke et gyldig klokkeslett (bruk f.eks. 08:00, 0800 eller kl 8).`,
  past: () => 'Det tidspunktet har allerede vært. Velg et tidspunkt fram i tid.',
  too_soon: () => 'Påminnelsen må være minst ett minutt fram i tid.',
  too_far: () => 'Påminnelser kan settes inntil to år fram i tid.',
};

function list(ctx: CommandContext) {
  const rows = ctx.jobs.active({ type: JOB_TYPE, createdBy: ctx.note.author.id, ticketId: ctx.note.ticketId });
  if (!rows.length) return ctx.reply('Du har ingen aktive påminnelser på denne saken.');
  const items = rows.map((r: JobRow) => {
    const p = JSON.parse(r.payload) as ReminderPayload;
    return `<b>${ref(r.id)}</b> ${short(local(r.run_at, ctx.config.timezone))}${p.message ? ` – «${escapeHtml(p.message)}»` : ''}`;
  });
  ctx.reply(`Dine aktive påminnelser på denne saken:<br>${items.join('<br>')}`);
}

const local = (iso: string, zone: string) => DateTime.fromISO(iso, { zone });

function cancel(ctx: CommandContext, arg: string) {
  const m = /^(?:r-?)?(\d+)$/i.exec(arg.trim());
  if (!m) return ctx.reply('Oppgi hvilken påminnelse som skal avbrytes, f.eks. <code>!remindme cancel R-12</code>.');
  const id = Number(m[1]);
  const job = ctx.jobs.get(id);
  if (!job || job.type !== JOB_TYPE || job.created_by !== ctx.note.author.id) {
    return ctx.reply(`Fant ingen påminnelse ${ref(id)} som tilhører deg.`);
  }
  if (job.status !== 'pending') return ctx.reply(`Påminnelse ${ref(id)} er ikke aktiv lenger.`);
  ctx.cancelJob(id);
  ctx.reply(`Påminnelse <b>${ref(id)}</b> er avbrutt.`);
}

export const remindme = defineCommand({
  name: 'remindme',
  aliases: ['påminn', 'paminn', 'remind'],
  summary: 'Minner deg på denne saken senere ved å tagge deg i et internt notat.',
  usage: [...EXAMPLES, 'remindme list', 'remindme cancel R-12'],
  run(ctx, args) {
    const [first = '', ...rest] = args.split(/\s+/);
    const sub = first.toLowerCase();
    if (['list', 'liste', 'vis'].includes(sub) && rest.length === 0) return list(ctx);
    if (['cancel', 'avbryt', 'slett', 'stopp'].includes(sub)) return cancel(ctx, rest.join(' '));
    if (['help', 'hjelp'].includes(sub)) return ctx.reply(`Bruk: ${examplesHtml()}`);

    // Count from when the note was WRITTEN, so "10d" still means 10 days after the note
    // even if the bot processes it late (e.g. after downtime). min() guards against clock skew.
    const base = ctx.note.created.isValid ? DateTime.min(ctx.note.created, ctx.now) : ctx.now;
    const when = parseWhen(args, base, { defaultTime: ctx.config.defaultTime });
    if (!when.ok) return ctx.reply(ERRORS[when.error](when.token));

    if (ctx.jobs.active({ type: JOB_TYPE, createdBy: ctx.note.author.id }).length >= MAX_ACTIVE_PER_USER) {
      return ctx.reply(`Du har allerede ${MAX_ACTIVE_PER_USER} aktive påminnelser. Avbryt noen før du lager flere.`);
    }

    const a = ctx.note.author;
    const payload: ReminderPayload = {
      userId: a.id, firstName: a.firstName, lastName: a.lastName, email: a.email,
      message: when.message, setAt: base.toISO()!,
    };
    const id = ctx.schedule(JOB_TYPE, when.at, payload);
    ctx.reply(`⏰ Påminnelse <b>${ref(id)}</b> satt til ${long(when.at)} (${relative(when.at, ctx.now)}).` +
      (when.message ? ` Melding: «${escapeHtml(when.message)}»` : ''));
  },
});

export const reminders = defineCommand({
  name: 'reminders',
  aliases: ['påminnelser', 'paminnelser'],
  summary: 'Viser dine aktive påminnelser på denne saken.',
  usage: ['reminders'],
  run: (ctx) => list(ctx),
});

export const fireReminder = defineJob<ReminderPayload>({
  type: JOB_TYPE,
  run(ctx) {
    const p = ctx.payload;
    const mention = mentionHtml({ id: p.userId, firstName: p.firstName, lastName: p.lastName, email: p.email });
    const zone = ctx.config.timezone;
    let html = `🔔 ${mention} påminnelse <b>${ref(ctx.job.id)}</b>` + (p.message ? `: «${escapeHtml(p.message)}»` : '') +
      `<br>Satt ${short(local(p.setAt, zone))}.`;
    if (ctx.lateByMs > LATE_NOTICE_MS) html += ` <i>(Forsinket – skulle vært sendt ${short(local(ctx.job.run_at, zone))}.)</i>`;
    ctx.reply(html);
  },
});
