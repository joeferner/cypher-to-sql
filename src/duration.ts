// Durations and temporal arithmetic, in TypeScript (see src/temporal.ts for the
// temporal values themselves). A duration is months, days, seconds, and
// nanoseconds of the second (0 to 999,999,999, with `seconds` rounded down),
// as in Neo4j: the units are kept apart because months and days have no fixed
// length. Construction cascades fractions down (a month is 2,629,746 seconds on
// average, a day 86,400), and rendering follows Neo4j's `P1Y2M3DT4H5M6.7S`.

import {
  civil,
  epochDayOf,
  offsetAtLocal,
  temporalFromMap,
  TemporalError,
  type Temporal,
  type TemporalArgument,
} from './temporal.js';

export interface Duration {
  months: bigint;
  days: bigint;
  seconds: bigint;
  /** 0 to 999,999,999. */
  nanos: bigint;
}

const NANOS = 1_000_000_000n;
const DAY_NANOS = 86_400n * NANOS;
/** Seconds of an average month (365.2425 / 12 days), for fractions of months. */
export const SECONDS_PER_MONTH = 2_629_746;

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};
const floorMod = (a: bigint, b: bigint): bigint => a - floorDiv(a, b) * b;

/** A duration from a total of nanoseconds (plus months and days). */
function normalized(months: bigint, days: bigint, nanos: bigint): Duration {
  return { months, days, seconds: floorDiv(nanos, NANOS), nanos: floorMod(nanos, NANOS) };
}

const totalNanos = (d: Duration): bigint => d.seconds * NANOS + d.nanos;

/**
 * A duration from amounts that may have fractions: whole months stay months,
 * a fraction of a month becomes days and seconds (2,629,746 seconds a month),
 * whole days stay days, and a fraction of a day becomes seconds.
 */
export function durationOf(months: number, days: number, nanos: number | bigint): Duration {
  const wholeMonths = Math.trunc(months);
  const monthSeconds = (months - wholeMonths) * SECONDS_PER_MONTH;
  const monthDays = Math.trunc(monthSeconds / 86_400);
  const wholeDays = Math.trunc(days);
  const fractionNanos = Math.round(
    (monthSeconds - monthDays * 86_400 + (days - wholeDays) * 86_400) * 1e9,
  );
  const extra = typeof nanos === 'bigint' ? nanos : BigInt(Math.round(nanos));
  return normalized(
    BigInt(wholeMonths),
    BigInt(wholeDays + monthDays),
    BigInt(fractionNanos) + extra,
  );
}

const DURATION_KEYS = [
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
  'hours',
  'minutes',
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
];

/** `duration({years: 1, days: 1.5, ...})`. */
export function durationFromMap(map: Record<string, TemporalArgument>): Duration {
  const v = (key: string): number => {
    const value = map[key];
    if (value === undefined || value === null) {
      return 0;
    }
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      throw new TemporalError(`Invalid value for ${key}`);
    }
    return Number(value);
  };
  for (const key of Object.keys(map)) {
    if (!DURATION_KEYS.includes(key)) {
      throw new TemporalError(`Invalid key for a duration: ${key}`);
    }
  }
  // Whole hours, minutes, seconds, and sub-seconds are exact; fractions round to nanoseconds.
  const exact = (key: string, nanos: bigint): bigint => {
    const value = map[key];
    if (typeof value === 'bigint') {
      return value * nanos;
    }
    return BigInt(Math.round(v(key) * Number(nanos)));
  };
  const nanos =
    exact('hours', 3600n * NANOS) +
    exact('minutes', 60n * NANOS) +
    exact('seconds', NANOS) +
    exact('milliseconds', 1_000_000n) +
    exact('microseconds', 1000n) +
    exact('nanoseconds', 1n);
  return durationOf(
    v('years') * 12 + v('quarters') * 3 + v('months'),
    v('weeks') * 7 + v('days'),
    nanos,
  );
}

const NUMBER = '([+-]?\\d+(?:[.,]\\d+)?)';
const ISO = new RegExp(
  `^([+-])?P(?:${NUMBER}Y)?(?:${NUMBER}M)?(?:${NUMBER}W)?(?:${NUMBER}D)?` +
    `(?:T(?:${NUMBER}H)?(?:${NUMBER}M)?(?:${NUMBER}S)?)?$`,
);
/** `P2012-02-02T14:37:21.545` */
const ALTERNATIVE = /^([+-])?P(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:[.,]\d+)?)$/;

/** `duration('P1Y2M3W4DT5H6M7.8S')` and `duration('P2012-02-02T14:37:21.545')`. */
export function parseDuration(text: string): Duration {
  const m = ISO.exec(text);
  const alt = m ? null : ALTERNATIVE.exec(text);
  if ((!m && !alt) || text === 'P' || text.endsWith('T')) {
    throw new TemporalError(`Invalid duration: ${text}`);
  }
  const groups = m ?? alt!;
  // Whole numbers stay exact (a duration in seconds can pass 2^53).
  const num = (i: number): number | bigint => {
    const text = (groups[i] ?? '0').replace(',', '.');
    return /^[+-]?\d+$/.test(text) ? BigInt(text) : Number(text);
  };
  const keys = m
    ? ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds']
    : ['years', 'months', 'days', 'hours', 'minutes', 'seconds'];
  const map: Record<string, TemporalArgument> = {};
  keys.forEach((key, i) => {
    map[key] = num(i + 2);
  });
  const d = durationFromMap(map);
  return groups[1] === '-' ? negate(d) : d;
}

export function negate(d: Duration): Duration {
  return normalized(-d.months, -d.days, -totalNanos(d));
}

export function addDurations(a: Duration, b: Duration): Duration {
  return normalized(a.months + b.months, a.days + b.days, totalNanos(a) + totalNanos(b));
}

/** A duration times a number (fractions cascade down, as in construction). */
export function multiplyDuration(d: Duration, factor: number): Duration {
  // A part of a nanosecond is dropped (toward zero), as in Neo4j.
  return durationOf(
    Number(d.months) * factor,
    Number(d.days) * factor,
    BigInt(Math.trunc(Number(totalNanos(d)) * factor)),
  );
}

// ---- components and rendering --------------------------------------------------

/** The components `d.years`, `d.days`, `d.nanosecondsOfSecond`, ... of a duration (Java's division). */
export function durationComponents(d: Duration): Record<string, bigint> {
  const { months, days, seconds, nanos } = d;
  return {
    years: months / 12n,
    quarters: months / 3n,
    months,
    weeks: days / 7n,
    days,
    hours: seconds / 3600n,
    minutes: seconds / 60n,
    seconds,
    milliseconds: seconds * 1000n + nanos / 1_000_000n,
    microseconds: seconds * 1_000_000n + nanos / 1000n,
    nanoseconds: seconds * NANOS + nanos,
    quartersOfYear: (months / 3n) % 4n,
    monthsOfQuarter: months % 3n,
    monthsOfYear: months % 12n,
    daysOfWeek: days % 7n,
    minutesOfHour: (seconds / 60n) % 60n,
    secondsOfMinute: seconds % 60n,
    millisecondsOfSecond: nanos / 1_000_000n,
    microsecondsOfSecond: nanos / 1000n,
    nanosecondsOfSecond: nanos,
  };
}

/** The text of a duration as Neo4j writes it: `P12Y5M14DT16H13M10.000000001S`, `PT-1M-0.001S`, `PT0S`. */
export function renderDuration(d: Duration): string {
  let text = 'P';
  const years = d.months / 12n;
  const months = d.months % 12n;
  if (years !== 0n) {
    text += `${years}Y`;
  }
  if (months !== 0n) {
    text += `${months}M`;
  }
  if (d.days !== 0n) {
    text += `${d.days}D`;
  }
  // Seconds and nanos as a signed whole and fraction: -60.001 is -60 and -0.001.
  let seconds = d.seconds;
  let nanos = d.nanos;
  const negative = seconds < 0n && nanos > 0n;
  if (negative) {
    seconds += 1n;
    nanos = NANOS - nanos;
  }
  if (seconds !== 0n || nanos !== 0n) {
    text += 'T';
    const hours = seconds / 3600n;
    const minutes = (seconds / 60n) % 60n;
    const rest = seconds % 60n;
    if (hours !== 0n) {
      text += `${hours}H`;
    }
    if (minutes !== 0n) {
      text += `${minutes}M`;
    }
    if (rest !== 0n || nanos !== 0n) {
      const sign = rest === 0n && (negative || seconds < 0n) && nanos !== 0n ? '-' : '';
      const fraction = nanos === 0n ? '' : `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}`;
      text += `${sign}${rest}${fraction}S`;
    }
  }
  return text === 'P' ? 'PT0S' : text;
}

// ---- temporal arithmetic -------------------------------------------------------

/** A date plus months, with the day clamped to the month's last day. */
function plusMonths(epochDay: number, months: bigint): number {
  const { year, month, day } = civil(epochDay);
  const total = BigInt(year) * 12n + BigInt(month - 1) + months;
  const y = Number(floorDiv(total, 12n));
  const m = Number(floorMod(total, 12n)) + 1;
  const last = civil(epochDayOf(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1).day;
  return epochDayOf(y, m, Math.min(day, last));
}

/**
 * A temporal value plus a duration: months (the day clamped), then days, then
 * the time, on the local value (a named zone's offset is taken at the new local
 * time). A date takes whole days of the time, toward zero; a time only the time.
 */
export function addToTemporal(t: Temporal, d: Duration): Temporal {
  if (t.epochDay === undefined) {
    const nanoOfDay = floorMod(t.nanoOfDay! + totalNanos(d), DAY_NANOS);
    return { ...t, nanoOfDay };
  }
  let epochDay = plusMonths(t.epochDay, d.months) + Number(d.days);
  if (t.nanoOfDay === undefined) {
    // Whole days of the time part, toward zero.
    return { ...t, epochDay: epochDay + Number(totalNanos(d) / DAY_NANOS) };
  }
  const nanos = t.nanoOfDay + totalNanos(d);
  epochDay += Number(floorDiv(nanos, DAY_NANOS));
  const local: Temporal = { ...t, epochDay, nanoOfDay: floorMod(nanos, DAY_NANOS) };
  if (t.zone === undefined) {
    return local;
  }
  // The offset of the zone at the new local time.
  const { year, month, day } = civil(epochDay);
  const ns = local.nanoOfDay!;
  return temporalFromMap(
    'datetime',
    {
      year,
      month,
      day,
      hour: Number(ns / (3600n * NANOS)),
      minute: Number((ns / (60n * NANOS)) % 60n),
      second: Number((ns / NANOS) % 60n),
      nanosecond: Number(ns % NANOS),
      timezone: t.zone,
    },
    () => t,
  );
}

// ---- durations between temporal values -----------------------------------------

/**
 * `local` (no zone) read in the zone of `zoned`: a named zone's offset at the
 * local time (on `zoned`'s date when `local` has none), or the same offset.
 */
function inZoneOf(local: Temporal, zoned: Temporal): Temporal {
  if (zoned.zone === undefined) {
    return { ...local, offsetSeconds: zoned.offsetSeconds! };
  }
  const day = local.epochDay ?? zoned.epochDay ?? 0;
  const seconds = day * 86_400 + Number((local.nanoOfDay ?? 0n) / NANOS);
  return { ...local, offsetSeconds: offsetAtLocal(zoned.zone, seconds) };
}

/**
 * The two values in one offset: `b` moved into `a`'s offset (same instant).
 * When only one has a zone, the other is read in that zone first.
 */
function aligned(first: Temporal, second: Temporal): { a: Temporal; b: Temporal } {
  let a = first;
  let b = second;
  if (a.offsetSeconds === undefined && b.offsetSeconds === undefined) {
    return { a, b };
  }
  if (a.offsetSeconds === undefined) {
    a = inZoneOf(a, b);
  } else if (b.offsetSeconds === undefined) {
    b = inZoneOf(b, a);
  }
  const offset = a.offsetSeconds!;
  const shift = BigInt(offset - b.offsetSeconds!) * NANOS;
  const nanos = (b.nanoOfDay ?? 0n) + shift;
  if (b.epochDay === undefined || a.epochDay === undefined) {
    // Times: compare by instant, without wrapping around the day.
    return { a, b: { ...b, nanoOfDay: nanos, offsetSeconds: offset } };
  }
  return {
    a,
    b: {
      ...b,
      epochDay: b.epochDay + Number(floorDiv(nanos, DAY_NANOS)),
      nanoOfDay: floorMod(nanos, DAY_NANOS),
      offsetSeconds: offset,
    },
  };
}

/** Whole months from `a` to `b` (dates), as java.time counts them. */
function monthsUntil(a: number, b: number): bigint {
  const packed = (epochDay: number): bigint => {
    const { year, month, day } = civil(epochDay);
    return (BigInt(year) * 12n + BigInt(month - 1)) * 32n + BigInt(day);
  };
  return (packed(b) - packed(a)) / 32n;
}

/** `b`'s date, moved by a day when its time would not complete the last unit (java.time's until). */
function endDate(a: Temporal, b: Temporal): number {
  const ta = a.nanoOfDay ?? 0n;
  const tb = b.nanoOfDay ?? 0n;
  if (b.epochDay! > a.epochDay! && tb < ta) {
    return b.epochDay! - 1;
  }
  if (b.epochDay! < a.epochDay! && tb > ta) {
    return b.epochDay! + 1;
  }
  return b.epochDay!;
}

/**
 * `duration.between(a, b)` and its `inMonths`, `inDays`, and `inSeconds`
 * forms. With dates on both sides: months, then days, then the rest of the
 * time; otherwise only the time between the times of day. Both with a zone:
 * `b` is taken in `a`'s offset.
 */
export function durationBetween(
  unit: 'between' | 'inMonths' | 'inDays' | 'inSeconds',
  first: Temporal,
  second: Temporal,
): Duration {
  const { a, b } = aligned(first, second);
  const ta = a.nanoOfDay ?? 0n;
  const tb = b.nanoOfDay ?? 0n;
  if (a.epochDay === undefined || b.epochDay === undefined) {
    return unit === 'inMonths' || unit === 'inDays'
      ? normalized(0n, 0n, 0n)
      : normalized(0n, 0n, tb - ta);
  }
  // Local times: `b` is in `a`'s offset when both have one (see aligned).
  const total = BigInt(b.epochDay) * DAY_NANOS + tb - (BigInt(a.epochDay) * DAY_NANOS + ta);
  if (unit === 'inSeconds') {
    return normalized(0n, 0n, total);
  }
  const end = endDate(a, b);
  if (unit === 'inDays') {
    return normalized(0n, BigInt(end - a.epochDay), 0n);
  }
  const months = monthsUntil(a.epochDay, end);
  if (unit === 'inMonths') {
    return normalized(months, 0n, 0n);
  }
  const shifted = plusMonths(a.epochDay, months);
  const days = BigInt(end - shifted);
  // The rest: the time between (start + months + days) and the end.
  const rest = total - (BigInt(shifted) + days - BigInt(a.epochDay)) * DAY_NANOS;
  return normalized(months, days, rest);
}
