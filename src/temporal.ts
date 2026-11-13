// Temporal values (date, localtime, time, localdatetime, datetime): parsing,
// construction from maps, components, and rendering, in TypeScript.
//
// This is the one implementation of the calendar rules. The planner evaluates
// temporal functions with known arguments here when it binds them, and SQLite
// calls it for other arguments through registerSqliteFunctions. In SQL a
// temporal value is a tagged JSON object that carries its components (so
// `d.year` is a member lookup), its rendered text (`~s`), and a sort key (`~k`)
// that orders values of one kind by instant; see `temporalJson`.
//
// Calendar: proleptic Gregorian, ISO weeks (Monday first; week 1 holds the
// year's first Thursday). Rendering follows Neo4j (Java's java.time).

/** The kinds of temporal values, as the `~cypher` tag of their JSON. */
export const TEMPORAL_KINDS = ['date', 'localtime', 'time', 'localdatetime', 'datetime'] as const;
export type TemporalKind = (typeof TEMPORAL_KINDS)[number];

export function isTemporalKind(value: unknown): value is TemporalKind {
  return (TEMPORAL_KINDS as readonly unknown[]).includes(value);
}

/**
 * A temporal value. `epochDay` is set for kinds with a date, `nanoOfDay` for
 * kinds with a time, `offsetSeconds` for time and datetime, and `zone` for a
 * datetime in a named time zone. A datetime's date and time are local (in its
 * offset).
 */
export interface Temporal {
  kind: TemporalKind;
  epochDay?: number;
  nanoOfDay?: bigint;
  offsetSeconds?: number;
  zone?: string;
}

/** An invalid argument to a temporal function. */
export class TemporalError extends Error {}

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400n * NANOS_PER_SECOND;

const hasDate = (kind: TemporalKind): boolean => kind !== 'localtime' && kind !== 'time';
const hasTime = (kind: TemporalKind): boolean => kind !== 'date';
const hasOffset = (kind: TemporalKind): boolean => kind === 'time' || kind === 'datetime';

// ---- calendar ------------------------------------------------------------------

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm). */
export function epochDayOf(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The calendar date of an epoch day. */
export function civil(epochDay: number): { year: number; month: number; day: number } {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** 1 (Monday) to 7 (Sunday). */
const weekDay = (epochDay: number): number => ((((epochDay + 3) % 7) + 7) % 7) + 1;

/** The ISO week-based year and week of an epoch day. */
function isoWeek(epochDay: number): { weekYear: number; week: number } {
  const thursday = epochDay - weekDay(epochDay) + 4;
  const weekYear = civil(thursday).year;
  return { weekYear, week: Math.floor((thursday - epochDayOf(weekYear, 1, 1)) / 7) + 1 };
}

function weeksInYear(weekYear: number): number {
  return isoWeek(epochDayOf(weekYear, 12, 28)).week;
}

/** The Monday of week 1 of a week-based year. */
function firstMonday(weekYear: number): number {
  const jan4 = epochDayOf(weekYear, 1, 4);
  return jan4 - weekDay(jan4) + 1;
}

const quarterStart = (year: number, quarter: number): number =>
  epochDayOf(year, (quarter - 1) * 3 + 1, 1);

// ---- time zones ----------------------------------------------------------------

const OFFSET = /^([+-])(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?$/;

/** The offset of `+01:00`, `-0130`, `+05`, `+02:05:59`, or `Z`; undefined for a zone name. */
function parseOffset(text: string): number | undefined {
  if (text === 'Z' || text === 'z') {
    return 0;
  }
  const m = OFFSET.exec(text);
  if (!m) {
    return undefined;
  }
  const seconds = Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  if (seconds > 18 * 3600) {
    throw new TemporalError(`Invalid time zone offset: ${text}`);
  }
  return m[1] === '-' ? -seconds : seconds;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The offset of a named zone (IANA) at an instant, in seconds. */
function zoneOffset(zone: string, epochSecond: number): number {
  let format = zoneFormats.get(zone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    } catch {
      throw new TemporalError(`Unknown time zone: ${zone}`);
    }
    zoneFormats.set(zone, format);
  }
  const millis = Math.max(-8.64e15, Math.min(8.64e15, epochSecond * 1000));
  const name = format.formatToParts(new Date(millis)).find((p) => p.type === 'timeZoneName');
  const offset = name?.value.replace(/^GMT/, '') ?? '';
  return offset === '' ? 0 : (parseOffset(offset) ?? 0);
}

/** A time zone of a map or string: an offset, or a named zone with its offset at a local time. */
interface Zone {
  offsetSeconds: number;
  zone?: string;
}

/** The zone `text` names, with its offset at the local time `localSecond` (seconds since the epoch, local). */
function zoneAtLocal(text: string, localSecond: number): Zone {
  const fixed = parseOffset(text);
  if (fixed !== undefined) {
    return { offsetSeconds: fixed };
  }
  // The offset in effect at the local time: try the offset at the local time
  // read as UTC, then the offset at the instant that gives.
  const first = zoneOffset(text, localSecond);
  const second = zoneOffset(text, localSecond - first);
  return { offsetSeconds: second, zone: text };
}

/** The zone `text` names, with its offset at the instant `epochSecond`. */
function zoneAtInstant(text: string, epochSecond: number): Zone {
  const fixed = parseOffset(text);
  return fixed !== undefined
    ? { offsetSeconds: fixed }
    : { offsetSeconds: zoneOffset(text, epochSecond), zone: text };
}

// ---- seconds and instants ------------------------------------------------------

/** Seconds since the epoch of a value's local date and time, and its nanos of second. */
function localSeconds(t: Temporal): { seconds: bigint; nanos: bigint } {
  const day = BigInt(t.epochDay ?? 0);
  const nanoOfDay = t.nanoOfDay ?? 0n;
  return {
    seconds: day * 86_400n + nanoOfDay / NANOS_PER_SECOND,
    nanos: nanoOfDay % NANOS_PER_SECOND,
  };
}

/** A datetime from seconds since the epoch (local) and nanos. */
function fromLocalSeconds(seconds: bigint, nanos: bigint): { epochDay: number; nanoOfDay: bigint } {
  let day = seconds / 86_400n;
  let rest = seconds % 86_400n;
  if (rest < 0n) {
    rest += 86_400n;
    day -= 1n;
  }
  return { epochDay: Number(day), nanoOfDay: rest * NANOS_PER_SECOND + nanos };
}

/** The same instant in another zone. */
function convert(t: Temporal, zoneText: string): Temporal {
  const { seconds, nanos } = localSeconds(t);
  const instant = seconds - BigInt(t.offsetSeconds ?? 0);
  const zone = zoneAtInstant(zoneText, Number(instant));
  if (t.kind === 'time') {
    const nanoOfDay =
      (((t.nanoOfDay! -
        BigInt(t.offsetSeconds!) * NANOS_PER_SECOND +
        BigInt(zone.offsetSeconds) * NANOS_PER_SECOND) %
        NANOS_PER_DAY) +
        NANOS_PER_DAY) %
      NANOS_PER_DAY;
    return { kind: 'time', nanoOfDay, offsetSeconds: zone.offsetSeconds };
  }
  return {
    kind: 'datetime',
    ...fromLocalSeconds(instant + BigInt(zone.offsetSeconds), nanos),
    offsetSeconds: zone.offsetSeconds,
    ...(zone.zone ? { zone: zone.zone } : {}),
  };
}

// ---- parsing -------------------------------------------------------------------

const YEAR = '([+-]\\d{4,9}|\\d{4})';
const DATE_FORMS: [RegExp, (m: RegExpExecArray) => number][] = [
  // 2015-W30-2, 2015W302, 2015-W30, 2015W30
  [
    new RegExp(`^${YEAR}-?W(\\d{2})(?:-?(\\d))?$`),
    (m): number => weekDate(Number(m[1]), Number(m[2]), Number(m[3] ?? 1)),
  ],
  // 2015-202, 2015202
  [new RegExp(`^${YEAR}-?(\\d{3})$`), (m): number => ordinalDate(Number(m[1]), Number(m[2]))],
  // 2015-07-21, 20150721
  [
    new RegExp(`^${YEAR}-?(\\d{2})-?(\\d{2})$`),
    (m): number => calendarDate(Number(m[1]), Number(m[2]), Number(m[3])),
  ],
  // 2015-07, 201507
  [new RegExp(`^${YEAR}-?(\\d{2})$`), (m): number => calendarDate(Number(m[1]), Number(m[2]), 1)],
  // 2015
  [new RegExp(`^${YEAR}$`), (m): number => calendarDate(Number(m[1]), 1, 1)],
];

function parseDate(text: string): number {
  for (const [form, make] of DATE_FORMS) {
    const m = form.exec(text);
    if (m) {
      return make(m);
    }
  }
  throw new TemporalError(`Invalid date: ${text}`);
}

/** `21:40:32.142`, `214032.142`, `21:40`, `2140`, `21`. */
const TIME = /^(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?$/;

function parseLocalTime(text: string): bigint {
  const m = TIME.exec(text);
  if (!m) {
    throw new TemporalError(`Invalid time: ${text}`);
  }
  return timeOfDay(
    Number(m[1]),
    Number(m[2] ?? 0),
    Number(m[3] ?? 0),
    BigInt((m[4] ?? '').padEnd(9, '0')),
  );
}

/** A time with an optional offset (`Z`, `+01:00`, ...) and an optional `[Zone/Name]`. */
function splitZone(text: string): { local: string; offset?: string; zone?: string } {
  const bracket = /^(.*?)(?:\[([^\]]+)\])?$/.exec(text)!;
  const body = bracket[1]!;
  const zone = bracket[2];
  const m = /^(.*?)(Z|z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/.exec(body)!;
  return {
    local: m[1]!,
    ...(m[2] !== undefined ? { offset: m[2] } : {}),
    ...(zone !== undefined ? { zone } : {}),
  };
}

/** Parses a temporal string of `kind`, as Neo4j accepts them. */
export function parseTemporal(kind: TemporalKind, text: string): Temporal {
  if (kind === 'date') {
    return { kind, epochDay: parseDate(text) };
  }
  if (kind === 'localtime') {
    return { kind, nanoOfDay: parseLocalTime(splitZone(text).local) };
  }
  if (kind === 'time') {
    const { local, offset } = splitZone(text);
    return {
      kind,
      nanoOfDay: parseLocalTime(local),
      offsetSeconds: offset === undefined ? 0 : parseOffsetStrict(offset),
    };
  }
  const t = text.indexOf('T');
  const datePart = t < 0 ? text : text.slice(0, t);
  const epochDay = parseDate(datePart);
  if (kind === 'localdatetime') {
    const nanoOfDay = t < 0 ? 0n : parseLocalTime(splitZone(text.slice(t + 1)).local);
    return { kind, epochDay, nanoOfDay };
  }
  const { local, offset, zone } = t < 0 ? splitZone('') : splitZone(text.slice(t + 1));
  const nanoOfDay = t < 0 ? 0n : parseLocalTime(local);
  const value: Temporal = { kind, epochDay, nanoOfDay, offsetSeconds: 0 };
  if (zone !== undefined) {
    // With both, the offset picks between two local times a zone has twice.
    const { seconds } = localSeconds(value);
    const z = zoneAtLocal(zone, Number(seconds));
    return {
      ...value,
      offsetSeconds: offset === undefined ? z.offsetSeconds : parseOffsetStrict(offset),
      zone,
    };
  }
  return { ...value, offsetSeconds: offset === undefined ? 0 : parseOffsetStrict(offset) };
}

function parseOffsetStrict(text: string): number {
  const offset = parseOffset(text);
  if (offset === undefined) {
    throw new TemporalError(`Invalid time zone offset: ${text}`);
  }
  return offset;
}

// ---- construction --------------------------------------------------------------

function check(ok: boolean, what: string): void {
  if (!ok) {
    throw new TemporalError(`Invalid value for ${what}`);
  }
}

function calendarDate(year: number, month: number, day: number): number {
  check(month >= 1 && month <= 12, 'month');
  check(day >= 1 && day <= daysInMonth(year, month), 'day');
  return epochDayOf(year, month, day);
}

function weekDate(weekYear: number, week: number, dayOfWeek: number): number {
  check(week >= 1 && week <= weeksInYear(weekYear), 'week');
  check(dayOfWeek >= 1 && dayOfWeek <= 7, 'dayOfWeek');
  return firstMonday(weekYear) + (week - 1) * 7 + dayOfWeek - 1;
}

function ordinalDate(year: number, ordinalDay: number): number {
  check(ordinalDay >= 1 && ordinalDay <= (isLeap(year) ? 366 : 365), 'ordinalDay');
  return epochDayOf(year, 1, 1) + ordinalDay - 1;
}

function quarterDate(year: number, quarter: number, dayOfQuarter: number): number {
  check(quarter >= 1 && quarter <= 4, 'quarter');
  const start = quarterStart(year, quarter);
  const end = quarter === 4 ? epochDayOf(year + 1, 1, 1) : quarterStart(year, quarter + 1);
  check(dayOfQuarter >= 1 && dayOfQuarter <= end - start, 'dayOfQuarter');
  return start + dayOfQuarter - 1;
}

function timeOfDay(hour: number, minute: number, second: number, nanos: bigint): bigint {
  check(hour >= 0 && hour <= 23, 'hour');
  check(minute >= 0 && minute <= 59, 'minute');
  check(second >= 0 && second <= 59, 'second');
  check(nanos >= 0n && nanos < NANOS_PER_SECOND, 'nanosecond');
  return (BigInt(hour) * 3600n + BigInt(minute) * 60n + BigInt(second)) * NANOS_PER_SECOND + nanos;
}

/** A value of a map passed to a temporal function: a number, a string, or a temporal. */
export type TemporalArgument = number | bigint | string | Temporal | null;

const DATE_KEYS = [
  'year',
  'month',
  'day',
  'week',
  'dayOfWeek',
  'ordinalDay',
  'quarter',
  'dayOfQuarter',
];
const TIME_KEYS = ['hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond'];

/**
 * A temporal of `kind` from a map, as Neo4j builds them: date fields in one of
 * four forms (calendar, week, ordinal, quarter), time fields, `timezone`, and a
 * value to start from (`date`, `time`, `datetime`) whose fields the map's
 * fields replace. With a `timezone`, a value that has a zone is converted to
 * it (same instant); one without gets it. `epochSeconds`/`epochMillis` give a
 * datetime's instant.
 */
export function temporalFromMap(
  kind: TemporalKind,
  map: Record<string, TemporalArgument>,
  now: () => Temporal,
): Temporal {
  const allowed = new Set([
    'timezone',
    ...(hasDate(kind) ? [...DATE_KEYS, 'date'] : []),
    ...(hasTime(kind) ? [...TIME_KEYS, 'time'] : []),
    ...(kind === 'localdatetime' || kind === 'datetime' ? ['datetime'] : []),
    ...(kind === 'datetime' ? ['epochSeconds', 'epochMillis'] : []),
  ]);
  for (const key of Object.keys(map)) {
    check(allowed.has(key), `key ${key}`);
  }
  const present = (key: string): boolean => map[key] !== undefined && map[key] !== null;
  const int = (key: string): number => {
    const v = map[key];
    check(typeof v === 'number' || typeof v === 'bigint', key);
    return Number(v);
  };
  const temporal = (key: string): Temporal => {
    const v = map[key];
    check(typeof v === 'object' && v !== null && 'kind' in v, key);
    return v as Temporal;
  };
  const timezone = present('timezone') ? map['timezone'] : undefined;
  check(timezone === undefined || typeof timezone === 'string', 'timezone');
  const keys = Object.keys(map).filter(present);
  if (keys.length === 0 || (keys.length === 1 && timezone !== undefined)) {
    // Only a time zone: the current time there.
    const current = now();
    const zoned = timezone === undefined ? current : convert(current, timezone as string);
    return project(kind, zoned);
  }

  if (kind === 'datetime' && (present('epochSeconds') || present('epochMillis'))) {
    const seconds = present('epochSeconds')
      ? BigInt(int('epochSeconds'))
      : BigInt(Math.floor(int('epochMillis') / 1000));
    const nanos = present('epochSeconds')
      ? BigInt(present('nanosecond') ? int('nanosecond') : 0)
      : BigInt((((int('epochMillis') % 1000) + 1000) % 1000) * 1_000_000);
    const utc: Temporal = {
      kind: 'datetime',
      ...fromLocalSeconds(seconds, nanos),
      offsetSeconds: 0,
    };
    return timezone === undefined ? utc : convert(utc, timezone as string);
  }

  // The value to start from, and the fields it supplies.
  const base = present('datetime') ? temporal('datetime') : undefined;
  const dateBase = present('date') ? temporal('date') : base;
  const timeBase = present('time') ? temporal('time') : base;
  if (dateBase) {
    check(dateBase.epochDay !== undefined, 'date');
  }
  if (timeBase) {
    check(timeBase.nanoOfDay !== undefined, 'time');
  }

  let epochDay: number | undefined;
  if (hasDate(kind)) {
    const from = dateBase?.epochDay;
    const c = from === undefined ? undefined : civil(from);
    const pick = (key: string, fallback: number | undefined, otherwise: number): number =>
      present(key) ? int(key) : (fallback ?? otherwise);
    if (present('week') || present('dayOfWeek')) {
      const w = from === undefined ? undefined : isoWeek(from);
      epochDay = weekDate(
        pick('year', w?.weekYear, NaN),
        pick('week', w?.week, 1),
        pick('dayOfWeek', from === undefined ? undefined : weekDay(from), 1),
      );
    } else if (present('ordinalDay')) {
      epochDay = ordinalDate(pick('year', c?.year, NaN), int('ordinalDay'));
    } else if (present('quarter') || present('dayOfQuarter')) {
      const year = pick('year', c?.year, NaN);
      const q = c ? Math.ceil(c.month / 3) : undefined;
      epochDay = quarterDate(
        year,
        pick('quarter', q, 1),
        pick(
          'dayOfQuarter',
          from === undefined ? undefined : from - quarterStart(c!.year, q!) + 1,
          1,
        ),
      );
    } else {
      epochDay = calendarDate(
        pick('year', c?.year, NaN),
        pick('month', c?.month, 1),
        pick('day', c?.day, 1),
      );
    }
    check(!Number.isNaN(epochDay), 'year');
  }

  let nanoOfDay: bigint | undefined;
  if (hasTime(kind)) {
    const from = timeBase?.nanoOfDay;
    const part = (unit: bigint, mod: bigint): number =>
      from === undefined ? 0 : Number((from / unit) % mod);
    const hour = present('hour') ? int('hour') : part(3600n * NANOS_PER_SECOND, 24n);
    const minute = present('minute') ? int('minute') : part(60n * NANOS_PER_SECOND, 60n);
    const second = present('second') ? int('second') : part(NANOS_PER_SECOND, 60n);
    let nanos: bigint;
    if (present('millisecond') || present('microsecond') || present('nanosecond')) {
      const ms = present('millisecond') ? int('millisecond') : 0;
      const us = present('microsecond') ? int('microsecond') : 0;
      const ns = present('nanosecond') ? int('nanosecond') : 0;
      check(ms >= 0 && ms < 1000 && us >= 0 && us < 1_000_000 && ns >= 0 && ns < 1e9, 'nanosecond');
      if (present('millisecond')) {
        check(us < 1000 && ns < 1_000_000, 'microsecond');
      }
      if (present('microsecond')) {
        check(ns < 1000, 'nanosecond');
      }
      if (from !== undefined && ms < 1000 && us < 1000 && ns < 1000) {
        // Over a base, each field replaces its own three digits of the fraction.
        const part = (key: string, scale: bigint, value: number): bigint =>
          present(key) ? BigInt(value) : ((from % NANOS_PER_SECOND) / scale) % 1000n;
        nanos =
          part('millisecond', 1_000_000n, ms) * 1_000_000n +
          part('microsecond', 1000n, us) * 1000n +
          part('nanosecond', 1n, ns);
      } else {
        nanos = BigInt(ms) * 1_000_000n + BigInt(us) * 1000n + BigInt(ns);
      }
    } else {
      nanos = from === undefined ? 0n : from % NANOS_PER_SECOND;
    }
    nanoOfDay = timeOfDay(hour, minute, second, nanos);
  } else if (present('hour')) {
    check(false, 'key hour');
  }

  if (!hasOffset(kind)) {
    return {
      kind,
      ...(epochDay !== undefined ? { epochDay } : {}),
      ...(nanoOfDay !== undefined ? { nanoOfDay } : {}),
    };
  }
  // The zone: the time base's (converted to `timezone` if given), else
  // `timezone`, else UTC. A `date` base gives no zone.
  const zonedBase = timeBase?.offsetSeconds !== undefined ? timeBase : undefined;
  const local: Temporal = {
    kind,
    ...(kind === 'datetime' ? { epochDay: epochDay! } : {}),
    nanoOfDay: nanoOfDay!,
    offsetSeconds: 0,
  };
  const { seconds } = localSeconds(local);
  if (zonedBase) {
    const inBase =
      zonedBase.zone !== undefined
        ? zoneAtLocal(zonedBase.zone, Number(seconds))
        : { offsetSeconds: zonedBase.offsetSeconds! };
    const value: Temporal = {
      ...local,
      offsetSeconds: inBase.offsetSeconds,
      ...(kind === 'datetime' && 'zone' in inBase && inBase.zone ? { zone: inBase.zone } : {}),
    };
    return timezone === undefined ? value : convert(value, timezone as string);
  }
  const zone =
    timezone === undefined
      ? { offsetSeconds: 0 }
      : zoneAtLocal(timezone as string, Number(seconds));
  return {
    ...local,
    offsetSeconds: zone.offsetSeconds,
    ...(kind === 'datetime' && zone.zone ? { zone: zone.zone } : {}),
  };
}

/**
 * A temporal of `kind` from another temporal value (`date(datetime)`): its
 * date and time parts as the kind needs them. A local value becomes a time or
 * datetime in UTC.
 */
export function project(kind: TemporalKind, from: Temporal): Temporal {
  if (hasDate(kind) && from.epochDay === undefined) {
    throw new TemporalError(`Cannot get a ${kind} from a ${from.kind}`);
  }
  if (kind === 'date') {
    return { kind, epochDay: from.epochDay! };
  }
  const nanoOfDay = from.nanoOfDay ?? 0n;
  if (kind === 'localtime') {
    return { kind, nanoOfDay };
  }
  if (kind === 'localdatetime') {
    return { kind, epochDay: from.epochDay!, nanoOfDay };
  }
  const offsetSeconds = from.offsetSeconds ?? 0;
  if (kind === 'time') {
    return { kind, nanoOfDay, offsetSeconds };
  }
  return {
    kind,
    epochDay: from.epochDay!,
    nanoOfDay,
    offsetSeconds,
    ...(from.zone ? { zone: from.zone } : {}),
  };
}

/** The units of `*.truncate()`, largest first; those before `hour` need a date. */
export const TRUNCATE_UNITS = [
  'millennium',
  'century',
  'decade',
  'year',
  'weekYear',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
  'microsecond',
] as const;

/**
 * The fields of `input` truncated to `unit`, as a map for temporalFromMap:
 * the date fields (when `withDate`) and the time fields down to the unit.
 */
export function truncatedFields(
  unit: string,
  input: Temporal,
  withDate: boolean,
): Record<string, TemporalArgument> {
  const index = (TRUNCATE_UNITS as readonly string[]).indexOf(unit);
  check(index >= 0, `unit ${unit}`);
  const c = temporalComponents(input);
  const n = (key: string): number => Number(c[key] ?? 0);
  const dateUnit = index < TRUNCATE_UNITS.indexOf('hour');
  check(!dateUnit || unit === 'day' || (withDate && input.epochDay !== undefined), `unit ${unit}`);
  if (withDate) {
    check(input.epochDay !== undefined, 'input');
  }
  const year = n('year');
  const dates: Record<string, Record<string, TemporalArgument>> = {
    millennium: { year: Math.floor(year / 1000) * 1000 },
    century: { year: Math.floor(year / 100) * 100 },
    decade: { year: Math.floor(year / 10) * 10 },
    year: { year },
    weekYear: { year: n('weekYear'), week: 1, dayOfWeek: 1 },
    quarter: { year, quarter: n('quarter') },
    month: { year, month: n('month') },
    week: { year: n('weekYear'), week: n('week'), dayOfWeek: 1 },
  };
  const fields: Record<string, TemporalArgument> = withDate
    ? (dates[unit] ?? { year, month: n('month'), day: n('day') })
    : {};
  // Time fields down to the unit (`day` and larger: midnight); the fraction as
  // whole milliseconds or microseconds.
  const times = ['hour', 'minute', 'second'];
  const kept = dateUnit ? 0 : Math.min(times.indexOf(unit) + 1 || 3, 3);
  fields['hour'] = 0;
  for (const key of times.slice(0, kept)) {
    fields[key] = n(key);
  }
  if (unit === 'millisecond' || unit === 'microsecond') {
    fields[unit] = n(unit);
  }
  return fields;
}

/**
 * `<kind>.truncate(unit, input, map)`: `input` truncated to `unit`, then the
 * map's fields set over it. A `timezone` in the map replaces the zone (the
 * local time stays); otherwise the input's zone is kept.
 */
export function truncateTemporal(
  kind: TemporalKind,
  unit: string,
  input: Temporal,
  overrides: Record<string, TemporalArgument>,
  now: () => Temporal,
): Temporal {
  const local = temporalFromMap(
    hasDate(kind) ? 'localdatetime' : 'localtime',
    truncatedFields(unit, input, hasDate(kind)),
    now,
  );
  const map: Record<string, TemporalArgument> = {
    ...(hasDate(kind) ? { date: local } : {}),
    ...(hasTime(kind) ? { time: local } : {}),
    ...overrides,
  };
  if (hasOffset(kind) && map['timezone'] === undefined && input.offsetSeconds !== undefined) {
    map['timezone'] = input.zone ?? renderOffset(input.offsetSeconds);
  }
  return temporalFromMap(kind, map, now);
}

/** The current time as a datetime in UTC. */
export function nowUtc(): Temporal {
  const millis = BigInt(Date.now());
  return {
    kind: 'datetime',
    ...fromLocalSeconds(millis / 1000n, (millis % 1000n) * 1_000_000n),
    offsetSeconds: 0,
  };
}

/** `datetime.fromepoch(seconds, nanos)` and `datetime.fromepochmillis(millis)`. */
export function fromEpoch(seconds: bigint, nanos: bigint): Temporal {
  return { kind: 'datetime', ...fromLocalSeconds(seconds, nanos), offsetSeconds: 0 };
}

// ---- components and rendering --------------------------------------------------

const pad = (n: number | bigint, width: number): string => String(n).padStart(width, '0');

function renderYear(year: number): string {
  if (year > 9999) {
    return `+${year}`;
  }
  return year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
}

function renderDate(epochDay: number): string {
  const { year, month, day } = civil(epochDay);
  return `${renderYear(year)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `HH:MM`, then `:SS` when seconds or nanos are set, then the fraction in groups of 3 digits. */
function renderTime(nanoOfDay: bigint): string {
  const seconds = nanoOfDay / NANOS_PER_SECOND;
  const nanos = nanoOfDay % NANOS_PER_SECOND;
  let text = `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}`;
  if (seconds % 60n !== 0n || nanos !== 0n) {
    text += `:${pad(seconds % 60n, 2)}`;
  }
  if (nanos !== 0n) {
    const digits = pad(nanos, 9);
    text += `.${nanos % 1_000_000n === 0n ? digits.slice(0, 3) : nanos % 1000n === 0n ? digits.slice(0, 6) : digits}`;
  }
  return text;
}

function renderOffset(seconds: number): string {
  if (seconds === 0) {
    return 'Z';
  }
  const abs = Math.abs(seconds);
  const text = `${seconds < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor(abs / 60) % 60, 2)}`;
  return abs % 60 === 0 ? text : `${text}:${pad(abs % 60, 2)}`;
}

/** The text of a temporal value, as `toString()` and results show it (`2015-07-21T21:40:32.142+01:00[Europe/Stockholm]`). */
export function renderTemporal(t: Temporal): string {
  switch (t.kind) {
    case 'date':
      return renderDate(t.epochDay!);
    case 'localtime':
      return renderTime(t.nanoOfDay!);
    case 'time':
      return renderTime(t.nanoOfDay!) + renderOffset(t.offsetSeconds!);
    case 'localdatetime':
      return `${renderDate(t.epochDay!)}T${renderTime(t.nanoOfDay!)}`;
    case 'datetime':
      return (
        `${renderDate(t.epochDay!)}T${renderTime(t.nanoOfDay!)}${renderOffset(t.offsetSeconds!)}` +
        (t.zone ? `[${t.zone}]` : '')
      );
  }
}

/**
 * A key that orders values of one kind as Cypher does, as text: dates by day,
 * local values by local time, times and datetimes by instant (UTC).
 */
export function sortKey(t: Temporal): string {
  let { seconds, nanos } = localSeconds(t);
  seconds -= BigInt(t.offsetSeconds ?? 0);
  if (t.nanoOfDay === undefined) {
    nanos = 0n;
  }
  return pad(seconds + 10n ** 18n, 19) + pad(nanos, 9);
}

/** The components `d.year`, `d.hour`, ... of a temporal value. */
export function temporalComponents(t: Temporal): Record<string, bigint | string> {
  const out: Record<string, bigint | string> = {};
  if (t.epochDay !== undefined) {
    const { year, month, day } = civil(t.epochDay);
    const { weekYear, week } = isoWeek(t.epochDay);
    const quarter = Math.ceil(month / 3);
    Object.assign(out, {
      year: BigInt(year),
      quarter: BigInt(quarter),
      month: BigInt(month),
      week: BigInt(week),
      weekYear: BigInt(weekYear),
      day: BigInt(day),
      ordinalDay: BigInt(t.epochDay - epochDayOf(year, 1, 1) + 1),
      weekDay: BigInt(weekDay(t.epochDay)),
      dayOfWeek: BigInt(weekDay(t.epochDay)),
      dayOfQuarter: BigInt(t.epochDay - quarterStart(year, quarter) + 1),
    });
  }
  if (t.nanoOfDay !== undefined) {
    const seconds = t.nanoOfDay / NANOS_PER_SECOND;
    const nanos = t.nanoOfDay % NANOS_PER_SECOND;
    Object.assign(out, {
      hour: seconds / 3600n,
      minute: (seconds / 60n) % 60n,
      second: seconds % 60n,
      millisecond: nanos / 1_000_000n,
      microsecond: nanos / 1000n,
      nanosecond: nanos,
    });
  }
  if (t.offsetSeconds !== undefined) {
    const offset = t.offsetSeconds === 0 ? '+00:00' : renderOffset(t.offsetSeconds);
    Object.assign(out, {
      timezone: t.zone ?? offset,
      offset,
      offsetMinutes: BigInt(Math.trunc(t.offsetSeconds / 60)),
      offsetSeconds: BigInt(t.offsetSeconds),
    });
  }
  if (t.kind === 'datetime') {
    const { seconds, nanos } = localSeconds(t);
    const epochSeconds = seconds - BigInt(t.offsetSeconds!);
    Object.assign(out, {
      epochSeconds,
      epochMillis: epochSeconds * 1000n + nanos / 1_000_000n,
    });
  }
  return out;
}
