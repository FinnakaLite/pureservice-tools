import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { parseWhen } from './parse.ts';

const ZONE = 'Europe/Oslo';
// Friday 6 Nov 2026, 10:05 in Oslo.
const NOW = DateTime.fromISO('2026-11-06T10:05:00', { zone: ZONE });

const at = (s: string, now = NOW) => {
  const r = parseWhen(s, now);
  if (!r.ok) assert.fail(`"${s}" failed with ${r.error}`);
  return r;
};
const local = (s: string) => DateTime.fromISO(s, { zone: ZONE }).toISO();

describe('parseWhen — durations', () => {
  const cases: [string, string][] = [
    ['10d', '2026-11-16T10:05:00'],
    ['10m', '2026-11-06T10:15:00'],
    ['1month', '2026-12-06T10:05:00'],
    ['1day', '2026-11-07T10:05:00'],
    ['2h30m', '2026-11-06T12:35:00'],
    ['1w 2d', '2026-11-15T10:05:00'],
    ['1w2d', '2026-11-15T10:05:00'],
    ['3 dager', '2026-11-09T10:05:00'],
    ['2 timer', '2026-11-06T12:05:00'],
    ['2t', '2026-11-06T12:05:00'],
    ['1mnd', '2026-12-06T10:05:00'],
    ['1mo', '2026-12-06T10:05:00'],
    ['2 uker', '2026-11-20T10:05:00'],
    ['1y', '2027-11-06T10:05:00'],
    ['10D', '2026-11-16T10:05:00'],
    ['1Month', '2026-12-06T10:05:00'],
    ['in 10 minutes', '2026-11-06T10:15:00'],
    ['om 10 minutter', '2026-11-06T10:15:00'],
    ['90min', '2026-11-06T11:35:00'],
  ];
  for (const [input, expected] of cases) it(input, () => assert.equal(at(input).at.toISO(), local(expected)));
});

describe('parseWhen — duration + time of day (all spellings)', () => {
  for (const input of ['10d 8:00', '10d 08:00', '10d 0800', '10d 08.00', '10d kl 8', '10d kl. 8', '10d at 8', '10d kl 08:00', '10d 8am'])
    it(input, () => assert.equal(at(input).at.toISO(), local('2026-11-16T08:00:00')));
  it('10d 14.30', () => assert.equal(at('10d 14.30').at.toISO(), local('2026-11-16T14:30:00')));
  it('1d 8pm', () => assert.equal(at('1d 8pm').at.toISO(), local('2026-11-07T20:00:00')));
});

describe('parseWhen — time of day only', () => {
  it('later today', () => assert.equal(at('14:30').at.toISO(), local('2026-11-06T14:30:00')));
  it('already passed → tomorrow', () => assert.equal(at('08:00').at.toISO(), local('2026-11-07T08:00:00')));
  it('0800', () => assert.equal(at('0800').at.toISO(), local('2026-11-07T08:00:00')));
  it('08.00 is a time (00 is not a month)', () => assert.equal(at('08.00').at.toISO(), local('2026-11-07T08:00:00')));
  it('10.30 is a time (30 is not a month)', () => assert.equal(at('10.30').at.toISO(), local('2026-11-06T10:30:00')));
  it('kl 9', () => assert.equal(at('kl 9').at.toISO(), local('2026-11-07T09:00:00')));
});

describe('parseWhen — dates', () => {
  const cases: [string, string][] = [
    ['imorgen', '2026-11-07T08:00:00'],
    ['i morgen', '2026-11-07T08:00:00'],
    ['tomorrow 14:00', '2026-11-07T14:00:00'],
    ['overmorgen', '2026-11-08T08:00:00'],
    ['fredag', '2026-11-13T08:00:00'],       // today is Friday → next Friday
    ['mandag kl 9', '2026-11-09T09:00:00'],
    ['monday 9:15', '2026-11-09T09:15:00'],
    ['24.12', '2026-12-24T08:00:00'],
    ['24.12.', '2026-12-24T08:00:00'],
    ['24.12 kl 9', '2026-12-24T09:00:00'],
    ['24.12 09.00', '2026-12-24T09:00:00'],
    ['24.12.2027 0900', '2027-12-24T09:00:00'],
    ['2026-12-24 13:00', '2026-12-24T13:00:00'],
    ['01.02', '2027-02-01T08:00:00'],        // passed this year → next year
    ['10.05', '2027-05-10T08:00:00'],        // documented rule: valid day.month on its own = date
    ['idag 15:00', '2026-11-06T15:00:00'],
  ];
  for (const [input, expected] of cases) it(input, () => assert.equal(at(input).at.toISO(), local(expected)));
});

describe('parseWhen — message text', () => {
  it('keeps the rest as message, with original case', () => {
    const r = at('10d 08:00 Ring Leverandør om ordre 4500');
    assert.equal(r.message, 'Ring Leverandør om ordre 4500');
  });
  it('a bare number after a duration is message text, not a time', () => {
    const r = at('2d 3 esker mangler');
    assert.equal(r.at.toISO(), local('2026-11-08T10:05:00'));
    assert.equal(r.message, '3 esker mangler');
  });
  it('an invalid 4-digit number after a duration is message text', () => assert.equal(at('2d 4500 kr refusjon').message, '4500 kr refusjon'));
  it('a weekday word after a duration is message text', () => assert.equal(at('2d man må ringe').message, 'man må ringe'));
  it('no message → empty string', () => assert.equal(at('5d').message, ''));
});

describe('parseWhen — calendar correctness', () => {
  it('1d across DST start keeps the clock time', () => {
    const now = DateTime.fromISO('2027-03-27T12:00:00', { zone: ZONE });
    assert.equal(at('1d', now).at.toISO(), local('2027-03-28T12:00:00'));
  });
  it('1d across DST end keeps the clock time', () => {
    const now = DateTime.fromISO('2026-10-24T12:00:00', { zone: ZONE });
    assert.equal(at('1d', now).at.toISO(), local('2026-10-25T12:00:00'));
  });
  it('31 Jan + 1 month = 28 Feb', () => {
    const now = DateTime.fromISO('2027-01-31T10:00:00', { zone: ZONE });
    assert.equal(at('1mo', now).at.toISO(), local('2027-02-28T10:00:00'));
  });
  it('an invalid date is not accepted', () => assert.equal(parseWhen('31.02.2027', NOW).ok, false));
});

describe('parseWhen — errors', () => {
  const cases: [string, string][] = [
    ['', 'empty'],
    ['hello there', 'unparsed'],
    ['5s', 'unparsed'],
    ['5', 'unparsed'],
    ['0m', 'too_soon'],
    ['3y', 'too_far'],
    ['99:99', 'invalid_time'],
    ['kl 25', 'invalid_time'],
    ['idag', 'past'],                       // today 08:00 has passed
    ['2026-01-01', 'past'],
  ];
  for (const [input, error] of cases) {
    it(`"${input}" → ${error}`, () => {
      const r = parseWhen(input, NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, error);
    });
  }
});
