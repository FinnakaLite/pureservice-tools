// "When" parser for !remindme. Pure function: (text, now) → absolute time + message.
//
//   <durations…> [time]      10d · 10m · 1month · 2h30m · 1w 2d · 3 dager · 10d 08:00
//   <time>                   08:00 · 0800 · 08.00 · kl 8 · at 8 · 8am   → next occurrence
//   <date> [time]            24.12 · 24.12.2026 · 2026-12-24 · imorgen · fredag · 24.12 kl 9
//
// Rules (see docs/PROPOSAL.md §6):
// - "m" is minutes; months are mo/mnd/month/måned.
// - A bare 1–2 digit number is NOT a time (it's message text) unless preceded by kl/at.
// - "X.YY" right after a duration/date is a time; on its own it's a date if it is a
//   valid day.month (e.g. 10.05), otherwise a time (08.00, 14.30).
// - Calendar arithmetic in the configured zone: 1d across DST keeps the clock time,
//   31 Jan + 1 month = 28/29 Feb.

import { DateTime, Duration, type DurationLikeObject } from 'luxon';

export type WhenError = 'empty' | 'unparsed' | 'invalid_time' | 'past' | 'too_soon' | 'too_far';
export type WhenResult =
  | { ok: true; at: DateTime; message: string }
  | { ok: false; error: WhenError; token?: string };

export interface ParseOptions {
  defaultTime?: { hour: number; minute: number };
  maxDays?: number;
  minSeconds?: number;
}

type Unit = keyof Pick<DurationLikeObject, 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years'>;

const UNITS = new Map<string, Unit>();
const addUnits = (unit: Unit, names: string[]) => names.forEach((n) => UNITS.set(n, unit));
addUnits('minutes', ['m', 'min', 'mins', 'minute', 'minutes', 'minutt', 'minutter', 'minuttar']);
addUnits('hours', ['h', 't', 'hr', 'hrs', 'hour', 'hours', 'time', 'timer', 'tim']);
addUnits('days', ['d', 'day', 'days', 'dag', 'dager', 'dagar', 'døgn']);
addUnits('weeks', ['w', 'u', 'wk', 'wks', 'week', 'weeks', 'uke', 'uker', 'veke', 'veker']);
addUnits('months', ['mo', 'mos', 'mnd', 'month', 'months', 'måned', 'måneder', 'maaned', 'maaneder', 'månad', 'månader']);
addUnits('years', ['y', 'yr', 'yrs', 'year', 'years', 'år']);

const TIME_PREFIX = new Set(['kl', 'kl.', 'klokka', 'klokken', 'at', '@']);
const LEADING_FILLER = new Set(['in', 'om']);

const WEEKDAYS = new Map<string, number>();
const addDay = (n: number, names: string[]) => names.forEach((x) => WEEKDAYS.set(x, n));
addDay(1, ['mandag', 'man', 'monday', 'mon']);
addDay(2, ['tirsdag', 'tir', 'tys', 'tuesday', 'tue', 'tues']);
addDay(3, ['onsdag', 'ons', 'wednesday', 'wed']);
addDay(4, ['torsdag', 'tor', 'thursday', 'thu', 'thur', 'thurs']);
addDay(5, ['fredag', 'fre', 'friday', 'fri']);
addDay(6, ['lørdag', 'lør', 'lordag', 'saturday', 'sat']);
addDay(7, ['søndag', 'søn', 'sondag', 'sunday', 'sun']);

const RELATIVE_DAYS = new Map<string, number>([
  ['idag', 0], ['today', 0],
  ['imorgen', 1], ['imorra', 1], ['tomorrow', 1], ['tmrw', 1],
  ['overimorgen', 2], ['overmorgen', 2],
]);

interface Clock { hour: number; minute: number }

function validClock(hour: number, minute: number): Clock | null {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** Time-of-day tokens that are unambiguous on their own (no dotted form). */
function parseClock(t: string): Clock | null | 'invalid' {
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return validClock(+m[1]!, +m[2]!) ?? 'invalid';
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t);
  if (m) {
    let h = +m[1]!;
    if (h < 1 || h > 12) return 'invalid';
    if (m[3] === 'am' && h === 12) h = 0;
    if (m[3] === 'pm' && h !== 12) h += 12;
    return validClock(h, m[2] ? +m[2] : 0) ?? 'invalid';
  }
  // 4-digit HHMM. An invalid one (e.g. "4500") is treated as message text, not an error.
  m = /^(\d{2})(\d{2})$/.exec(t);
  if (m) return validClock(+m[1]!, +m[2]!);
  return null;
}

function parseDotted(t: string): { clock: Clock | null; dayMonth: { day: number; month: number } | null } | null {
  const m = /^(\d{1,2})\.(\d{2})$/.exec(t);
  if (!m) return null;
  const a = +m[1]!, b = +m[2]!;
  return {
    clock: validClock(a, b),
    dayMonth: a >= 1 && a <= 31 && b >= 1 && b <= 12 ? { day: a, month: b } : null,
  };
}

/** Returns the date at start of day, or null. */
function parseDate(t: string, now: DateTime): DateTime | null {
  const today = now.startOf('day');
  if (RELATIVE_DAYS.has(t)) return today.plus({ days: RELATIVE_DAYS.get(t)! });
  if (WEEKDAYS.has(t)) {
    const diff = (WEEKDAYS.get(t)! - today.weekday + 7) % 7 || 7; // strictly the next one
    return today.plus({ days: diff });
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return checked(today, +m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(t);
  if (m) return checked(today, m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(t);
  if (m) return dayMonthNoYear(today, +m[1]!, +m[2]!);
  return null;
}

function checked(today: DateTime, year: number, month: number, day: number): DateTime | null {
  const d = DateTime.fromObject({ year, month, day }, { zone: today.zone });
  return d.isValid && d.day === day ? d : null;
}

/** dd.mm without a year: this year, or next year if that date has passed. */
function dayMonthNoYear(today: DateTime, day: number, month: number): DateTime | null {
  const d = checked(today, today.year, month, day);
  if (d) return d < today ? checked(today, today.year + 1, month, day) : d;
  return checked(today, today.year + 1, month, day); // e.g. 29.02 → next leap year only if valid
}

function compactDuration(t: string): Duration | null {
  if (!/^(\d+[\p{L}]+)+$/u.test(t)) return null;
  const parts: DurationLikeObject = {};
  for (const m of t.matchAll(/(\d+)([\p{L}]+)/gu)) {
    const unit = UNITS.get(m[2]!);
    if (!unit) return null;
    parts[unit] = (parts[unit] ?? 0) + Number(m[1]);
  }
  return Duration.fromObject(parts);
}

export function parseWhen(input: string, now: DateTime, opts: ParseOptions = {}): WhenResult {
  const defaultTime = opts.defaultTime ?? { hour: 8, minute: 0 };
  const maxDays = opts.maxDays ?? 731;
  const minSeconds = opts.minSeconds ?? 60;

  const raw = input.trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return { ok: false, error: 'empty' };

  // Join two-word forms ("i morgen", "i dag", "i overmorgen") into one token.
  const tokens: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!.toLowerCase(), b = raw[i + 1]?.toLowerCase();
    if (a === 'i' && b && RELATIVE_DAYS.has(`i${b}`)) { tokens.push(`i${raw[i + 1]}`); i++; }
    else tokens.push(raw[i]!);
  }

  let duration: Duration | null = null;
  let date: DateTime | null = null;
  let clock: Clock | null = null;
  let i = 0;

  for (; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase().replace(/,$/, '');
    const next = tokens[i + 1]?.toLowerCase();
    const anchored = duration !== null || date !== null;

    if (i === 0 && LEADING_FILLER.has(t) && next) continue;

    if (!clock && TIME_PREFIX.has(t) && next) {
      const n = /^(\d{1,2})$/.exec(next);
      const c = n ? validClock(+n[1]!, 0) : (parseClock(next) ?? parseDotted(next)?.clock ?? null);
      if (!c || c === 'invalid') return { ok: false, error: 'invalid_time', token: tokens[i + 1] };
      clock = c; i++; continue;
    }

    if (!date) {
      const d = compactDuration(t);
      if (d) { duration = duration ? duration.plus(d) : d; continue; }
      if (/^\d+$/.test(t) && next && UNITS.has(next.replace(/,$/, ''))) {
        const d2 = Duration.fromObject({ [UNITS.get(next.replace(/,$/, ''))!]: Number(t) });
        duration = duration ? duration.plus(d2) : d2; i++; continue;
      }
    }

    if (!clock) {
      const c = parseClock(t);
      if (c === 'invalid') return { ok: false, error: 'invalid_time', token: tokens[i] };
      if (c) { clock = c; continue; }
      const dotted = parseDotted(t);
      if (dotted && (anchored || !dotted.dayMonth) && dotted.clock) { clock = dotted.clock; continue; }
    }

    if (!date && !duration) {
      const d = parseDate(t, now);
      if (d) { date = d; continue; }
    }
    break;
  }

  const message = tokens.slice(i).join(' ').trim();
  if (!duration && !date && !clock) return { ok: false, error: 'unparsed', token: tokens[0] };

  let at: DateTime;
  if (duration) {
    at = now.plus(duration);
    if (clock) at = at.set({ hour: clock.hour, minute: clock.minute, second: 0, millisecond: 0 });
  } else if (date) {
    const c = clock ?? defaultTime;
    at = date.set({ hour: c.hour, minute: c.minute, second: 0, millisecond: 0 });
  } else {
    at = now.set({ hour: clock!.hour, minute: clock!.minute, second: 0, millisecond: 0 });
    if (at <= now) at = at.plus({ days: 1 });
  }

  if (!at.isValid) return { ok: false, error: 'too_far' };
  const diffSec = at.diff(now, 'seconds').seconds;
  if (diffSec < minSeconds) return { ok: false, error: diffSec <= 0 && !duration ? 'past' : 'too_soon' };
  if (at.diff(now, 'days').days > maxDays) return { ok: false, error: 'too_far' };
  return { ok: true, at, message };
}
