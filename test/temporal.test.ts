// The temporal core (src/temporal.ts) on its own, with examples from the TCK.

import { describe, expect, it } from 'vitest';
import {
  nowUtc,
  parseTemporal,
  project,
  renderTemporal,
  sortKey,
  temporalComponents,
  temporalFromMap,
  TemporalError,
  type Temporal,
  type TemporalArgument,
  type TemporalKind,
} from '../src/temporal.js';

const fromMap = (kind: TemporalKind, map: Record<string, TemporalArgument>): string =>
  renderTemporal(temporalFromMap(kind, map, nowUtc));
const parse = (kind: TemporalKind, text: string): string =>
  renderTemporal(parseTemporal(kind, text));
const t = (kind: TemporalKind, text: string): Temporal => parseTemporal(kind, text);

describe('temporal values', () => {
  it('builds dates from maps in all four forms', () => {
    expect(fromMap('date', { year: 1816, week: 1 })).toBe('1816-01-01');
    expect(fromMap('date', { year: 1817, week: 1 })).toBe('1816-12-30');
    expect(fromMap('date', { year: 1818, week: 53 })).toBe('1818-12-28');
    expect(fromMap('date', { dayOfWeek: 2, year: 1817, week: 1 })).toBe('1816-12-31');
    expect(fromMap('date', { date: t('date', '1816-12-30'), week: 2, dayOfWeek: 3 })).toBe(
      '1817-01-08',
    );
    expect(fromMap('date', { date: t('date', '1816-12-31'), year: 1817, week: 2 })).toBe(
      '1817-01-07',
    );
    expect(fromMap('date', { year: 1984, month: 10, day: 11 })).toBe('1984-10-11');
    expect(fromMap('date', { year: 1984, ordinalDay: 202 })).toBe('1984-07-20');
    expect(fromMap('date', { year: 1984, quarter: 3, dayOfQuarter: 45 })).toBe('1984-08-14');
    const other = t('date', '1984-11-11');
    expect(fromMap('date', { date: other, year: 28 })).toBe('0028-11-11');
    expect(fromMap('date', { date: other, week: 1 })).toBe('1984-01-08');
    expect(fromMap('date', { date: other, ordinalDay: 28 })).toBe('1984-01-28');
    expect(fromMap('date', { date: other, quarter: 3 })).toBe('1984-08-11');
  });

  it('builds times and datetimes with sub-seconds and time zones', () => {
    expect(
      fromMap('localtime', {
        hour: 12,
        minute: 31,
        second: 14,
        millisecond: 645,
        microsecond: 876,
        nanosecond: 123,
      }),
    ).toBe('12:31:14.645876123');
    expect(fromMap('localtime', { hour: 12, minute: 31, second: 14, microsecond: 645876 })).toBe(
      '12:31:14.645876',
    );
    expect(fromMap('time', { hour: 12, minute: 34, second: 56, timezone: '+02:05:59' })).toBe(
      '12:34:56+02:05:59',
    );
    expect(fromMap('time', { hour: 12 })).toBe('12:00Z');
    expect(
      fromMap('datetime', { year: 1984, week: 10, dayOfWeek: 3, hour: 12, timezone: '+01:00' }),
    ).toBe('1984-03-07T12:00+01:00');
    expect(
      fromMap('datetime', {
        year: 1984,
        month: 10,
        day: 11,
        hour: 12,
        timezone: 'Europe/Stockholm',
      }),
    ).toBe('1984-10-11T12:00+01:00[Europe/Stockholm]');
    const stockholm = t('datetime', '1984-10-11T12:00+01:00[Europe/Stockholm]');
    expect(fromMap('datetime', { datetime: stockholm, timezone: '+05:00' })).toBe(
      '1984-10-11T16:00+05:00',
    );
    expect(
      fromMap('datetime', {
        datetime: stockholm,
        day: 28,
        second: 42,
        timezone: 'Pacific/Honolulu',
      }),
    ).toBe('1984-10-28T01:00:42-10:00[Pacific/Honolulu]');
    const local = t('localdatetime', '1984-03-07T12:31:14.645');
    expect(fromMap('datetime', { datetime: local, timezone: '+05:00' })).toBe(
      '1984-03-07T12:31:14.645+05:00',
    );
    expect(fromMap('datetime', { epochSeconds: 416779, nanosecond: 999999999 })).toBe(
      '1970-01-05T19:46:19.999999999Z',
    );
  });

  it('parses the ISO forms Neo4j accepts', () => {
    for (const [text, out] of [
      ['20150721', '2015-07-21'],
      ['201507', '2015-07-01'],
      ['2015W302', '2015-07-21'],
      ['2015-W30', '2015-07-20'],
      ['2015202', '2015-07-21'],
      ['2015', '2015-01-01'],
    ]) {
      expect(parse('date', text!)).toBe(out);
    }
    expect(parse('localtime', '214032.142')).toBe('21:40:32.142');
    expect(parse('localtime', '21')).toBe('21:00');
    expect(parse('datetime', '2015-07-21T21:40:32.142+0100')).toBe('2015-07-21T21:40:32.142+01:00');
    expect(parse('datetime', '2015-W30T2140-00:00')).toBe('2015-07-20T21:40Z');
    expect(parse('datetime', '2015202T21+18:00')).toBe('2015-07-21T21:00+18:00');
    expect(parse('datetime', '2015-07-21T21:40:32.142[Europe/London]')).toBe(
      '2015-07-21T21:40:32.142+01:00[Europe/London]',
    );
    expect(parse('datetime', '1818-07-21T21:40:32.142[Europe/Stockholm]')).toBe(
      '1818-07-21T21:40:32.142+00:53:28[Europe/Stockholm]',
    );
    expect(() => parse('date', '2015-13-01')).toThrow(TemporalError);
    expect(() => parse('datetime', '2015-07-21T10:00[Nope/Zone]')).toThrow(TemporalError);
  });

  it('gives components, projections, and an order by instant', () => {
    expect(temporalComponents(t('date', '1984-10-11'))).toMatchObject({
      year: 1984n,
      quarter: 4n,
      week: 41n,
      weekYear: 1984n,
      ordinalDay: 285n,
      weekDay: 4n,
      dayOfQuarter: 11n,
    });
    expect(temporalComponents(t('date', '1984-01-01'))).toMatchObject({
      weekYear: 1983n,
      week: 52n,
      weekDay: 7n,
    });
    expect(temporalComponents(t('time', '12:31:14.645876123+01:00'))).toMatchObject({
      millisecond: 645n,
      microsecond: 645876n,
      nanosecond: 645876123n,
      timezone: '+01:00',
      offsetMinutes: 60n,
      offsetSeconds: 3600n,
    });
    expect(renderTemporal(project('date', t('datetime', '1984-11-11T12:00+01:00')))).toBe(
      '1984-11-11',
    );
    expect(renderTemporal(project('datetime', t('localdatetime', '1984-03-07T12:31')))).toBe(
      '1984-03-07T12:31Z',
    );
    expect(sortKey(t('time', '10:00+01:00')) < sortKey(t('time', '09:35Z'))).toBe(true);
    expect(sortKey(t('date', '1980-12-24')) < sortKey(t('date', '1984-10-11'))).toBe(true);
    expect(sortKey(t('date', '-0001-01-01')) < sortKey(t('date', '0001-01-01'))).toBe(true);
  });
});
