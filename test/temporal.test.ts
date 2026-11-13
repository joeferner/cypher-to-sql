// The temporal core (src/temporal.ts) on its own, with examples from the TCK.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherArgumentError,
  CypherTypeError,
  type CypherValue,
  type Graph,
} from '../src/index.js';
import { testBackends } from './support/backends.js';
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

for (const backend of testBackends()) {
  describe(`temporal functions of row values on ${backend.name}`, () => {
    let graph: Graph;
    beforeAll(async () => {
      const { dialect, executor } = await backend.open();
      graph = createGraph({ dialect, executor });
    });
    afterAll(() => backend.dispose?.());

    /** `RETURN toString(<expr>)` for each `x` in `xs` (so the arguments are row values). */
    const each = async (expr: string, xs: CypherValue[]): Promise<CypherValue[]> =>
      (await graph.query(`UNWIND $xs AS x RETURN toString(${expr}) AS v`, { xs })).map(
        (r) => r['v']!,
      );

    it('builds values from strings, maps, and other values in the database', async () => {
      expect(
        await each('date(x)', [
          '2015-07-21',
          '20150721',
          '2015-W30-2',
          '2015202',
          '2015-07',
          '2015',
        ]),
      ).toEqual([
        '2015-07-21',
        '2015-07-21',
        '2015-07-21',
        '2015-07-21',
        '2015-07-01',
        '2015-01-01',
      ]);
      expect(await each('localtime(x)', ['214032.142', '21:40', '21'])).toEqual([
        '21:40:32.142',
        '21:40',
        '21:00',
      ]);
      expect(
        await each('datetime(x)', [
          '2015-07-21T21:40:32.142+0100',
          '2015-W30T2140-00:00',
          '2015-07-21T21:40:32.142[Europe/London]',
          '1818-07-21T21:40:32.142[Europe/Stockholm]',
        ]),
      ).toEqual([
        '2015-07-21T21:40:32.142+01:00',
        '2015-07-20T21:40Z',
        '2015-07-21T21:40:32.142+01:00[Europe/London]',
        '1818-07-21T21:40:32.142+00:53:28[Europe/Stockholm]',
      ]);
      expect(
        await each('date(x)', [
          { year: 1817n, week: 1n },
          { year: 1984n, ordinalDay: 202n },
          { year: 1984n, quarter: 3n, dayOfQuarter: 45n },
        ]),
      ).toEqual(['1816-12-30', '1984-07-20', '1984-08-14']);
      expect(
        await each('time(x)', [{ hour: 12n, minute: 34n, second: 56n, timezone: '+02:05:59' }]),
      ).toEqual(['12:34:56+02:05:59']);
      const stockholm = "datetime('1984-10-11T12:00+01:00[Europe/Stockholm]')";
      expect(
        await graph.query(
          `WITH ${stockholm} AS o UNWIND [1] AS one
           RETURN toString(datetime({datetime: o, timezone: '+05:00'})) AS a,
                  toString(datetime({datetime: o, day: 28, second: 42, timezone: 'Pacific/Honolulu'})) AS b,
                  toString(date({date: o, week: 1})) AS c, toString(localtime(o)) AS d,
                  toString(time({time: time('10:00+01:00'), timezone: '+05:00'})) AS e`,
        ),
      ).toEqual([
        {
          a: '1984-10-11T16:00+05:00',
          b: '1984-10-28T01:00:42-10:00[Pacific/Honolulu]',
          c: '1984-01-05',
          d: '12:00',
          e: '14:00+05:00',
        },
      ]);
    });

    it('truncates row values, with fields and time zones over the result', async () => {
      const x = "datetime('1984-10-11T12:31:14.645876123+01:00')";
      const run = async (expr: string): Promise<CypherValue> =>
        (await graph.query(`WITH ${x} AS x UNWIND [1] AS one RETURN toString(${expr}) AS v`))[0]![
          'v'
        ]!;
      expect(await run(`date.truncate('millennium', x, {day: 2})`)).toBe('1000-01-02');
      expect(await run(`date.truncate('weekYear', x)`)).toBe('1984-01-02');
      expect(await run(`date.truncate('week', x, {dayOfWeek: 2})`)).toBe('1984-10-09');
      expect(await run(`datetime.truncate('quarter', x)`)).toBe('1984-10-01T00:00+01:00');
      expect(await run(`datetime.truncate('year', x, {timezone: 'Europe/Stockholm'})`)).toBe(
        '1984-01-01T00:00+01:00[Europe/Stockholm]',
      );
      expect(await run(`localdatetime.truncate('millisecond', x, {nanosecond: 2})`)).toBe(
        '1984-10-11T12:31:14.645000002',
      );
      expect(await run(`time.truncate('minute', x)`)).toBe('12:31+01:00');
      expect(await run(`localtime.truncate('microsecond', x)`)).toBe('12:31:14.645876');
      expect(await run(`localtime.truncate('day', x)`)).toBe('00:00');
    });

    it('builds durations and computes with them on row values', async () => {
      expect(
        await each('duration(x)', [
          'P14DT16H12M',
          'P0.75M',
          'P2012-02-02T14:37:21.545',
          { days: 14n, hours: 16n, minutes: 12n },
          { months: 5n, days: 1.5 },
          { minutes: 12n, seconds: -60n },
        ]),
      ).toEqual([
        'P14DT16H12M',
        'P22DT19H51M49.5S',
        'P2012Y2M2DT14H37M21.545S',
        'P14DT16H12M',
        'P5M1DT12H',
        'PT11M',
      ]);
      const d =
        'duration({years: 12, months: 5, days: 14, hours: 16, minutes: 12, seconds: 70, nanoseconds: 2})';
      const [row] = await graph.query(
        `WITH ${d} AS d, date('1984-10-11') AS a, localtime('12:31:14.000000001') AS b,
              datetime('1984-10-11T12:31:14.000000001+01:00') AS c UNWIND [1] AS one
         RETURN toString(a + d) AS a1, toString(a - d) AS a2, toString(b + d) AS b1,
                toString(c + d) AS c1, toString(d + d) AS dd, toString(d * 0.5) AS half,
                toString(d / 2) AS div, d.days AS days, d.monthsOfYear AS moy,
                toString(duration.between(a, c)) AS between,
                toString(duration.inSeconds(b, c)) AS secs, d = d AS same`,
      );
      expect(row).toEqual({
        a1: '1997-03-25',
        a2: '1972-04-27',
        b1: '04:44:24.000000003',
        c1: '1997-03-26T04:44:24.000000003+01:00',
        dd: 'P24Y10M28DT32H26M20.000000004S',
        half: 'P6Y2M22DT13H21M8.000000001S',
        div: 'P6Y2M22DT13H21M8.000000001S',
        days: 14n,
        moy: 5n,
        between: 'PT12H31M14.000000001S',
        secs: 'PT0S',
        same: true,
      });
      await expect(
        graph.query(`WITH ${d} AS d UNWIND [1] AS one RETURN d + 1 AS x`),
      ).rejects.toThrow(CypherTypeError);
    });

    it('gives components that match values built in the library', async () => {
      const [row] = await graph.query(
        `UNWIND ['1984-10-11T12:31:14.645876123+01:00'] AS s
         WITH datetime(s) AS x, datetime('1984-10-11T12:31:14.645876123+01:00') AS y
         RETURN x = y AS same, x.week AS week, x.ordinalDay AS ordinal, x.epochMillis AS millis`,
      );
      expect(row).toEqual({ same: true, week: 41n, ordinal: 285n, millis: 466342274645n });
      await expect(graph.query("UNWIND ['2015-13-01'] AS s RETURN date(s) AS d")).rejects.toThrow(
        CypherArgumentError,
      );
      expect(await graph.query('UNWIND [null] AS s RETURN date(s) AS d')).toEqual([{ d: null }]);
    });
  });
}
