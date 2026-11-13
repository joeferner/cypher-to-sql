// Temporal functions of values known only at run time, in PostgreSQL SQL (see
// Dialect.temporalCall): the rules of src/temporal.ts, for years 1 to 9999.
// (Calls whose arguments are known before the query runs are evaluated in
// TypeScript, for any year.)
//
// Every input becomes a map of fields first (a string is parsed into one, a
// temporal value becomes `{date: x, time: x}`), then a chain of LATERAL stages
// builds the value, each computing its columns once: the bases, the local date
// (a PostgreSQL date) and time (nanoseconds of the day), the zone, and the
// tagged JSON with the components and text that src/json.ts temporalJson writes.

import { TEMPORAL_KINDS, TRUNCATE_UNITS, type TemporalKind } from '../temporal.js';
import { postgresDurationCall } from './postgres-duration.js';

/** An error with this text prefix becomes a CypherArgumentError (see plan.ts). */
const ERROR = 'cypher temporal error: ';

/**
 * Fails the statement with `message` (SQL text) when evaluated. `random()`
 * keeps PostgreSQL from folding a constant message (and failing) at plan time
 * in a branch that is never taken.
 */
export const fail = (message: string): string =>
  `(('${ERROR}' || ${message} || substr(random()::text, 1, 0))::int)`;

const pad = (n: string, width: number): string => `lpad((${n})::text, ${width}, '0')`;
const TEMPORAL_TYPES = `(${TEMPORAL_KINDS.map((k) => `'${k}'`).join(', ')})`;
const EPOCH = `DATE '1970-01-01'`;
const DAY_NANOS = '86400000000000';

const hasDate = (kind: TemporalKind): boolean => kind !== 'localtime' && kind !== 'time';
const hasTime = (kind: TemporalKind): boolean => kind !== 'date';
const hasOffset = (kind: TemporalKind): boolean => kind === 'time' || kind === 'datetime';

// ---- parsing into a map --------------------------------------------------------

const YEAR = '([+-]\\d{4,9}|\\d{4})';

/** The fields of a date string as a JSON map (calendar, week, or ordinal). */
function dateFields(text: string): string {
  const m = (re: string): string => `regexp_match(${text}, '${re}')`;
  return (
    `(SELECT CASE ` +
    `WHEN p.w IS NOT NULL THEN jsonb_build_object('year', p.w[1]::bigint, 'week', p.w[2]::bigint, ` +
    `'dayOfWeek', coalesce(p.w[3], '1')::bigint) ` +
    `WHEN p.o IS NOT NULL THEN jsonb_build_object('year', p.o[1]::bigint, 'ordinalDay', p.o[2]::bigint) ` +
    `WHEN p.c IS NOT NULL THEN jsonb_build_object('year', p.c[1]::bigint, 'month', ` +
    `coalesce(p.c[2], p.c[4], '1')::bigint, 'day', coalesce(p.c[3], '1')::bigint) ` +
    `ELSE ${fail(`'Invalid date: ' || ${text}`)}::text::jsonb END ` +
    `FROM (SELECT ${m(`^${YEAR}-?W(\\d{2})(?:-?(\\d))?$`)} AS w, ${m(`^${YEAR}-?(\\d{3})$`)} AS o, ` +
    `${m(`^${YEAR}(?:-?(\\d{2})-?(\\d{2})|-?(\\d{2}))?$`)} AS c) p)`
  );
}

/** The fields of a time string (`21:40:32.142`, `2140`, ...) with its offset or `[zone]`. */
function timeFields(text: string): string {
  return (
    `(SELECT CASE WHEN g.r IS NULL THEN ${fail(`'Invalid time: ' || ${text}`)}::text::jsonb ` +
    `ELSE jsonb_strip_nulls(jsonb_build_object('hour', g.r[1]::bigint, 'minute', coalesce(g.r[2], '0')::bigint, ` +
    `'second', coalesce(g.r[3], '0')::bigint, 'nanosecond', rpad(coalesce(g.r[4], ''), 9, '0')::bigint, ` +
    `'timezone', coalesce(g.zone, g.off))) END ` +
    `FROM (SELECT z.zone, z.off, regexp_match(left(z.body, length(z.body) - length(coalesce(z.off, ''))), ` +
    `'^(\\d{2})(?::?(\\d{2})(?::?(\\d{2})(?:[.,](\\d{1,9}))?)?)?$') AS r ` +
    `FROM (SELECT y.zone, y.body, substring(y.body from '((?:Z|z|[+-]\\d{2}(?::?\\d{2}(?::?\\d{2})?)?))$') AS off ` +
    `FROM (SELECT substring(x.t from '\\[([^\\]]+)\\]$') AS zone, regexp_replace(x.t, '\\[[^\\]]+\\]$', '') AS body ` +
    `FROM (SELECT ${text} AS t) x) y) z) g)`
  );
}

/** A temporal string of `kind` as a map of fields. */
function stringFields(kind: TemporalKind, text: string): string {
  if (kind === 'date') {
    return dateFields(text);
  }
  if (kind === 'localtime' || kind === 'time') {
    return timeFields(text);
  }
  return (
    `(SELECT ${dateFields('s.d')} || (CASE WHEN s.t = '' THEN '{}'::jsonb ELSE ${timeFields('s.t')} END) ` +
    `FROM (SELECT split_part(s0.t, 'T', 1) AS d, ` +
    `(CASE WHEN position('T' in s0.t) > 0 THEN substr(s0.t, position('T' in s0.t) + 1) ELSE '' END) AS t ` +
    `FROM (SELECT ${text} AS t) s0) s)`
  );
}

// ---- the stages ----------------------------------------------------------------

/** Seconds of a fixed offset (`+01:00`, `-0130`, `+05`, `Z`), or NULL for a zone name. */
function offsetOf(text: string): string {
  return (
    `(SELECT CASE WHEN o.t IN ('Z', 'z') THEN 0 WHEN o.r IS NULL THEN NULL ` +
    `ELSE (CASE WHEN o.r[1] = '-' THEN -1 ELSE 1 END) * (o.r[2]::int * 3600 + ` +
    `coalesce(o.r[3], '0')::int * 60 + coalesce(o.r[4], '0')::int) END ` +
    `FROM (SELECT p.t, regexp_match(p.t, '^([+-])(\\d{2})(?::?(\\d{2})(?::?(\\d{2}))?)?$') AS r ` +
    `FROM (SELECT (${text})::text AS t) p) o)`
  );
}

/** The offset of named zone `zone` at local timestamp `local`. */
export const offsetAtLocal = (zone: string, local: string): string =>
  `extract(epoch FROM ${local} - ((${local} AT TIME ZONE ${zone}) AT TIME ZONE 'UTC'))::int`;

/** The offset of named zone `zone` at an instant (seconds since the epoch). */
const offsetAtInstant = (zone: string, instant: string): string =>
  `extract(epoch FROM (to_timestamp(${instant}) AT TIME ZONE ${zone}) - ` +
  `(to_timestamp(${instant}) AT TIME ZONE 'UTC'))::int`;

/**
 * The local date `dt` and time `ns` from the map `f.m` and its bases `i.bd`
 * (gives the date) and `i.bt` (gives the time): date fields in four forms,
 * time fields; only a time zone (or nothing) is the current time.
 */
function local(kind: TemporalKind): string {
  const has = (key: string): string => `coalesce(jsonb_typeof(f.m -> '${key}') <> 'null', false)`;
  const num = (key: string): string => `(f.m ->> '${key}')::int`;
  const base = (b: string, key: string): string => `(i.${b} ->> '${key}')::int`;
  const pick = (key: string, b: string, baseKey: string, otherwise?: string): string =>
    `coalesce(${num(key)}, ${base(b, baseKey)}${otherwise === undefined ? '' : `, ${otherwise}`})`;
  const year = pick('year', 'bd', 'year');
  const jan4 = `make_date(${pick('year', 'bd', 'weekYear')}, 1, 4)`;
  const date = hasDate(kind)
    ? `(CASE WHEN ${has('week')} OR ${has('dayOfWeek')} THEN ` +
      `${jan4} - (extract(isodow FROM ${jan4})::int - 1) + (${pick('week', 'bd', 'week', '1')} - 1) * 7 + ` +
      `${pick('dayOfWeek', 'bd', 'dayOfWeek', '1')} - 1 ` +
      `WHEN ${has('ordinalDay')} THEN make_date(${year}, 1, 1) + ${num('ordinalDay')} - 1 ` +
      `WHEN ${has('quarter')} OR ${has('dayOfQuarter')} THEN ` +
      `make_date(${year}, (${pick('quarter', 'bd', 'quarter', '1')} - 1) * 3 + 1, 1) + ` +
      `${pick('dayOfQuarter', 'bd', 'dayOfQuarter', '1')} - 1 ` +
      `ELSE make_date(${year}, ${pick('month', 'bd', 'month', '1')}, ${pick('day', 'bd', 'day', '1')}) END)`
    : EPOCH;
  const subsecond = `${has('millisecond')} OR ${has('microsecond')} OR ${has('nanosecond')}`;
  const ms = `(f.m ->> 'millisecond')::bigint`;
  const us = `(f.m ->> 'microsecond')::bigint`;
  const ns = `(f.m ->> 'nanosecond')::bigint`;
  const baseNanos = `(i.bt ->> 'nanosecond')::bigint`;
  // Over a base, each field replaces its own three digits of the fraction.
  const fraction =
    `(CASE WHEN i.bt IS NOT NULL AND coalesce(${ms}, 0) < 1000 AND coalesce(${us}, 0) < 1000 ` +
    `AND coalesce(${ns}, 0) < 1000 THEN coalesce(${ms}, ${baseNanos} / 1000000 % 1000) * 1000000 + ` +
    `coalesce(${us}, ${baseNanos} / 1000 % 1000) * 1000 + coalesce(${ns}, ${baseNanos} % 1000) ` +
    `ELSE coalesce(${ms}, 0) * 1000000 + coalesce(${us}, 0) * 1000 + coalesce(${ns}, 0) END)`;
  const time = hasTime(kind)
    ? `((${pick('hour', 'bt', 'hour', '0')} * 3600 + ${pick('minute', 'bt', 'minute', '0')} * 60 + ` +
      `${pick('second', 'bt', 'second', '0')})::bigint * 1000000000 + (CASE WHEN ${subsecond} THEN ` +
      `${fraction} ELSE coalesce(${baseNanos}, 0) END))`
    : '0::bigint';
  const now = `(extract(epoch FROM now()) * 1000000)::bigint`;
  const onlyZone = `NOT EXISTS (SELECT 1 FROM jsonb_each(f.m) e WHERE e.key <> 'timezone' AND jsonb_typeof(e.value) <> 'null')`;
  return (
    `SELECT (CASE WHEN ${onlyZone} THEN ${EPOCH} + (${now} / 86400000000)::int ELSE ${date} END) AS dt, ` +
    `(CASE WHEN ${onlyZone} THEN (${now} % 86400000000) * 1000 ELSE ${time} END) AS ns`
  );
}

/** The bases: `bd` gives the date, `bt` the time (with its zone, if any). */
const BASES =
  `SELECT (CASE WHEN (f.m -> 'date' -> 'year') IS NOT NULL THEN f.m -> 'date' ` +
  `WHEN (f.m -> 'datetime' -> 'year') IS NOT NULL THEN f.m -> 'datetime' END) AS bd, ` +
  `(CASE WHEN (f.m -> 'time' -> 'hour') IS NOT NULL THEN f.m -> 'time' ` +
  `WHEN (f.m -> 'datetime' -> 'hour') IS NOT NULL THEN f.m -> 'datetime' END) AS bt`;

/**
 * The zone stages. A time base with a zone keeps it (a named zone's offset at
 * the new local time), converted to `timezone` (same instant) if given;
 * otherwise `timezone` applies at the local time, or UTC. Gives `off`, `zone`,
 * and `shift` (seconds the local time moves by the conversion).
 */
const ZONE_INPUTS =
  `SELECT (i.bt ->> 'offsetSeconds')::int AS off0, ` +
  `(CASE WHEN (i.bt ->> 'timezone') !~ '^[+-]' THEN i.bt ->> 'timezone' END) AS zone0, ` +
  `f.m ->> 'timezone' AS tz, (i.bt -> 'offsetSeconds') IS NOT NULL AS based, ` +
  `${offsetOf(`f.m ->> 'timezone'`)} AS tzfixed, ` +
  `(l.dt + make_interval(secs => l.ns / 1000000000.0))::timestamp AS lt, ` +
  `(l.dt - ${EPOCH})::bigint * 86400 + l.ns / 1000000000 AS ls`;

const BASE_OFFSET = `SELECT (CASE WHEN z.zone0 IS NOT NULL THEN ${offsetAtLocal('z.zone0', 'z.lt')} ELSE z.off0 END) AS boff`;

const ZONE =
  `SELECT q.off, q.zone, (CASE WHEN z.based AND z.tz IS NOT NULL THEN q.off - b.boff ELSE 0 END) AS shift ` +
  `FROM (SELECT (CASE WHEN z.based AND z.tz IS NULL THEN b.boff ` +
  `WHEN z.based THEN coalesce(z.tzfixed, ${offsetAtInstant('z.tz', 'z.ls - b.boff')}) ` +
  `WHEN z.tz IS NULL THEN 0 ELSE coalesce(z.tzfixed, ${offsetAtLocal('z.tz', 'z.lt')}) END) AS off, ` +
  `(CASE WHEN z.based AND z.tz IS NULL THEN z.zone0 WHEN z.tzfixed IS NULL THEN z.tz END) AS zone) q`;

/** The final local date `dt` and time `ns`, moved by `y.shift`. */
function shifted(kind: TemporalKind): string {
  if (kind === 'time') {
    return `SELECT l.dt, (((l.ns + y.shift::bigint * 1000000000) % ${DAY_NANOS}) + ${DAY_NANOS}) % ${DAY_NANOS} AS ns`;
  }
  const seconds = `(z.ls + y.shift)`;
  return (
    `SELECT ${EPOCH} + floor(${seconds} / 86400.0)::int AS dt, ` +
    `((${seconds} % 86400 + 86400) % 86400) * 1000000000 + l.ns % 1000000000 AS ns`
  );
}

// ---- rendering -----------------------------------------------------------------

/** The tagged JSON of a value of `kind` from `v.dt`, `v.ns`, `y.off`, `y.zone`, and calendar fields `c`. */
function render(kind: TemporalKind): string {
  const f = FRAGMENTS;
  const parts: string[] = [`'~cypher', '${kind}'`];
  const text: string[] = [];
  // Seconds of the instant (or of the local value): date, plus time, minus offset.
  let seconds = '0';
  if (hasDate(kind)) {
    seconds = f.dateSeconds;
    text.push(f.dateText);
    parts.push(...f.dateParts);
  }
  if (hasTime(kind)) {
    seconds = `${seconds} + ${f.timeSeconds}`;
    text.push(text.length > 0 ? `'T' || ${f.timeText}` : f.timeText);
    parts.push(...f.timeParts);
  }
  if (hasOffset(kind)) {
    seconds = `${seconds} - y.off`;
    text.push(f.offsetText);
    parts.push(...f.offsetParts);
    if (kind === 'datetime') {
      text.push(f.zoneText);
      parts.push(...f.epochParts(seconds));
    }
  }
  parts.push(
    `'~s', ${text.join(' || ')}`,
    `'~k', ${f.key(seconds, hasTime(kind) ? f.nanos : '0')}`,
  );
  return `jsonb_build_object(${parts.join(', ')})`;
}

/**
 * The SQL pieces of a temporal value's JSON, from columns `v.dt` (date),
 * `v.ns` (nanoseconds of the day), `y.off`, `y.zone`, and calendar fields `c`.
 */
const FRAGMENTS = ((): {
  dateSeconds: string;
  dateText: string;
  dateParts: string[];
  timeSeconds: string;
  timeText: string;
  timeParts: string[];
  nanos: string;
  offsetText: string;
  zoneText: string;
  offsetParts: string[];
  epochParts: (seconds: string) => string[];
  key: (seconds: string, nanos: string) => string;
} => {
  const s = `(v.ns / 1000000000)`;
  const nanos = `(v.ns % 1000000000)`;
  const abs = `abs(y.off)`;
  const offset =
    `(CASE WHEN y.off < 0 THEN '-' ELSE '+' END) || ${pad(`${abs} / 3600`, 2)} || ':' || ` +
    `${pad(`${abs} / 60 % 60`, 2)} || (CASE WHEN ${abs} % 60 <> 0 THEN ':' || ${pad(`${abs} % 60`, 2)} ELSE '' END)`;
  return {
    dateSeconds: `(v.dt - ${EPOCH})::bigint * 86400`,
    dateText: `${pad('c.y', 4)} || '-' || ${pad('c.mo', 2)} || '-' || ${pad('c.d', 2)}`,
    dateParts: [
      `'year', c.y`,
      `'quarter', c.q`,
      `'month', c.mo`,
      `'week', c.w`,
      `'weekYear', c.wy`,
      `'day', c.d`,
      `'ordinalDay', c.doy`,
      `'weekDay', c.dow`,
      `'dayOfWeek', c.dow`,
      `'dayOfQuarter', v.dt - make_date(c.y, (c.q - 1) * 3 + 1, 1) + 1`,
    ],
    timeSeconds: `v.ns / 1000000000`,
    timeText:
      `${pad(`${s} / 3600`, 2)} || ':' || ${pad(`${s} / 60 % 60`, 2)} || ` +
      `(CASE WHEN ${s} % 60 <> 0 OR ${nanos} <> 0 THEN ':' || ${pad(`${s} % 60`, 2)} ELSE '' END) || ` +
      `(CASE WHEN ${nanos} = 0 THEN '' WHEN ${nanos} % 1000000 = 0 THEN '.' || left(${pad(nanos, 9)}, 3) ` +
      `WHEN ${nanos} % 1000 = 0 THEN '.' || left(${pad(nanos, 9)}, 6) ELSE '.' || ${pad(nanos, 9)} END)`,
    timeParts: [
      `'hour', ${s} / 3600`,
      `'minute', ${s} / 60 % 60`,
      `'second', ${s} % 60`,
      `'millisecond', ${nanos} / 1000000`,
      `'microsecond', ${nanos} / 1000`,
      `'nanosecond', ${nanos}`,
    ],
    nanos,
    offsetText: `(CASE WHEN y.off = 0 THEN 'Z' ELSE ${offset} END)`,
    zoneText: `coalesce('[' || y.zone || ']', '')`,
    offsetParts: [
      `'timezone', coalesce(y.zone, ${offset})`,
      `'offset', ${offset}`,
      `'offsetMinutes', trunc(y.off / 60.0)::bigint`,
      `'offsetSeconds', y.off`,
    ],
    epochParts: (seconds) => [
      `'epochSeconds', ${seconds}`,
      `'epochMillis', (${seconds}) * 1000 + (v.ns % 1000000000) / 1000000`,
    ],
    key: (seconds, keyNanos) =>
      `${pad(`(${seconds}) + 1000000000000000000`, 19)} || ${pad(keyNanos, 9)}`,
  };
})();

/**
 * Like `render`, for a kind known only at run time (`kind`, SQL text): a stage
 * (to be named `x`, after `c`) that computes the text pieces and seconds once,
 * and one JSON object whose parts each apply when the kind has them.
 */
export function renderAnyKind(kind: string): { stage: string; json: string } {
  const f = FRAGMENTS;
  const among = (...kinds: TemporalKind[]): string =>
    `${kind} IN (${kinds.map((k) => `'${k}'`).join(', ')})`;
  const dated = among('date', 'localdatetime', 'datetime');
  const timed = among('localtime', 'time', 'localdatetime', 'datetime');
  const zoned = among('time', 'datetime');
  const stageSql =
    `SELECT (CASE WHEN ${dated} THEN ${f.dateText} END) AS dtx, ` +
    `(CASE WHEN ${timed} THEN ${f.timeText} END) AS ttx, ` +
    `(CASE WHEN ${zoned} THEN ${f.offsetText} END) AS otx, ` +
    `(CASE WHEN ${dated} THEN ${f.dateSeconds} ELSE 0 END) + ` +
    `(CASE WHEN ${timed} THEN ${f.timeSeconds} ELSE 0 END) - ` +
    `(CASE WHEN ${zoned} THEN y.off ELSE 0 END) AS secs`;
  const part = (condition: string, parts: string[]): string =>
    `(CASE WHEN ${condition} THEN jsonb_build_object(${parts.join(', ')}) ELSE '{}'::jsonb END)`;
  const text =
    `(CASE ${kind} WHEN 'date' THEN x.dtx WHEN 'localtime' THEN x.ttx WHEN 'time' THEN x.ttx || x.otx ` +
    `WHEN 'localdatetime' THEN x.dtx || 'T' || x.ttx ` +
    `ELSE x.dtx || 'T' || x.ttx || x.otx || ${f.zoneText} END)`;
  return {
    stage: stageSql,
    json:
      `jsonb_build_object('~cypher', ${kind}) || ${part(dated, f.dateParts)} || ` +
      `${part(timed, f.timeParts)} || ${part(zoned, f.offsetParts)} || ` +
      `${part(`${kind} = 'datetime'`, f.epochParts('x.secs'))} || ` +
      `jsonb_build_object('~s', ${text}, '~k', ${f.key('x.secs', `(CASE WHEN ${timed} THEN ${f.nanos} ELSE 0 END)`)})`,
  };
}

/** The calendar fields of `v.dt` (stage `c`). */
export const CALENDAR =
  `SELECT extract(year FROM v.dt)::int AS y, extract(month FROM v.dt)::int AS mo, ` +
  `extract(day FROM v.dt)::int AS d, extract(quarter FROM v.dt)::int AS q, ` +
  `extract(week FROM v.dt)::int AS w, extract(isoyear FROM v.dt)::int AS wy, ` +
  `extract(doy FROM v.dt)::int AS doy, extract(isodow FROM v.dt)::int AS dow`;

// ---- the call ------------------------------------------------------------------

/**
 * Temporal function `name` of the JSON array `args`, as a temporal value's
 * tagged JSON (NULL for a null argument).
 */
export function postgresTemporalCall(name: string, args: string): string {
  if (name === 'duration' || name.startsWith('duration.')) {
    return postgresDurationCall(name, args);
  }
  if (name === 'datetime.fromepoch' || name === 'datetime.fromepochmillis') {
    const nanos =
      name === 'datetime.fromepoch'
        ? `(a.a ->> 0)::numeric * 1000000000 + (a.a ->> 1)::numeric`
        : `(a.a ->> 0)::numeric * 1000000`;
    return (
      `(SELECT ${render('datetime')} FROM ${stage(`SELECT (${args}) AS a`, 'a')}, ` +
      `${stage(`SELECT ${nanos} AS n`, 't')}, ` +
      `${stage(
        `SELECT ${EPOCH} + floor(t.n / ${DAY_NANOS})::int AS dt, ` +
          `((t.n % ${DAY_NANOS} + ${DAY_NANOS}) % ${DAY_NANOS})::bigint AS ns`,
        'v',
      )}, ` +
      `${stage('SELECT 0 AS off, NULL::text AS zone', 'y')}, ${stage(CALENDAR, 'c')} ` +
      `WHERE t.n IS NOT NULL)`
    );
  }
  const [kindName, clock] = name.split('.');
  const kind = kindName as TemporalKind;
  if (clock === 'truncate') {
    return truncate(kind, args);
  }
  const x = `(a.a -> 0)`;
  // No argument: the current time (an empty map of fields).
  const none = `jsonb_array_length(a.a) = 0`;
  // The map of fields: a parsed string, a temporal value to start from, a map,
  // or (for .statement() and the like) a time zone.
  const fields = clock
    ? `(CASE WHEN ${none} THEN '{}'::jsonb ELSE jsonb_build_object('timezone', ${x}) END)`
    : `(CASE WHEN ${none} THEN '{}'::jsonb ELSE (CASE jsonb_typeof(${x}) ` +
      `WHEN 'string' THEN ${stringFields(kind, `(${x} #>> '{}')`)} ` +
      `WHEN 'object' THEN (CASE WHEN ${x} ->> '~cypher' IN ${TEMPORAL_TYPES} THEN ` +
      `jsonb_build_object(${[
        ...(hasDate(kind) ? [`'date', ${x}`] : []),
        ...(hasTime(kind) ? [`'time', ${x}`] : []),
      ].join(', ')}) ELSE ${x} END) ` +
      `ELSE ${fail(`'Invalid argument for ${name}()'`)}::text::jsonb END) END)`;
  const zone = hasOffset(kind)
    ? [
        stage(ZONE_INPUTS, 'z'),
        stage(BASE_OFFSET, 'b'),
        stage(ZONE, 'y'),
        stage(shifted(kind), 'v'),
      ]
    : [stage('SELECT 0 AS off, NULL::text AS zone', 'y'), stage('SELECT l.dt, l.ns', 'v')];
  return (
    `(SELECT ${render(kind)} FROM ` +
    [
      stage(`SELECT (${args}) AS a`, 'a'),
      stage(`SELECT ${fields} AS m`, 'f'),
      stage(BASES, 'i'),
      stage(local(kind), 'l'),
      ...zone,
      stage(hasDate(kind) ? CALENDAR : 'SELECT 0 AS y', 'c'),
    ].join(', ') +
    ` WHERE ${none} OR coalesce(jsonb_typeof(${x}), 'null') <> 'null')`
  );
}

/**
 * `<kind>.truncate(unit, input, map)` (see truncateTemporal): the input's
 * fields truncated to the unit build a local value, and the result is built
 * from `{date: local, time: local}` with the map's fields and `timezone` (the
 * input's zone when the map has none) over it.
 */
function truncate(kind: TemporalKind, args: string): string {
  const x = `(tr.a -> 1)`;
  const n = (key: string): string => `(${x} ->> '${key}')::int`;
  const year = n('year');
  const day = `'year', ${year}, 'month', ${n('month')}, 'day', ${n('day')}`;
  const datePart = (unit: string): string => {
    switch (unit) {
      case 'millennium':
      case 'century':
      case 'decade': {
        const size = { millennium: 1000, century: 100, decade: 10 }[unit];
        return `'year', floor(${year} / ${size}.0)::int * ${size}`;
      }
      case 'year':
        return `'year', ${year}`;
      case 'weekYear':
        return `'year', ${n('weekYear')}, 'week', 1, 'dayOfWeek', 1`;
      case 'quarter':
        return `'year', ${year}, 'quarter', ${n('quarter')}`;
      case 'month':
        return `'year', ${year}, 'month', ${n('month')}`;
      case 'week':
        return `'year', ${n('weekYear')}, 'week', ${n('week')}, 'dayOfWeek', 1`;
      default:
        return day;
    }
  };
  const timePart = (unit: string): string => {
    const units = ['hour', 'minute', 'second'];
    const kept = units.indexOf(unit) < 0 ? 3 : units.indexOf(unit) + 1;
    const fields = units.slice(0, kept).map((u) => `'${u}', ${n(u)}`);
    if (unit === 'millisecond' || unit === 'microsecond') {
      fields.push(`'${unit}', ${n(unit)}`);
    }
    return fields.join(', ');
  };
  const withDate = hasDate(kind);
  const arms = TRUNCATE_UNITS.map((unit) => {
    const dateUnit = TRUNCATE_UNITS.indexOf(unit) < TRUNCATE_UNITS.indexOf('hour');
    if (!withDate && dateUnit && unit !== 'day') {
      return '';
    }
    const fields = [...(withDate ? [datePart(unit)] : []), dateUnit ? `'hour', 0` : timePart(unit)];
    return `WHEN '${unit}' THEN jsonb_build_object(${fields.join(', ')})`;
  }).join(' ');
  const truncated = `(CASE tr.a ->> 0 ${arms} ELSE ${fail(`'Invalid unit: ' || (tr.a ->> 0)`)}::text::jsonb END)`;
  const local = postgresTemporalCall(
    withDate ? 'localdatetime' : 'localtime',
    `jsonb_build_array(${truncated})`,
  );
  const bases = [...(withDate ? [`'date', t.l`] : []), ...(hasTime(kind) ? [`'time', t.l`] : [])];
  const zone = hasOffset(kind)
    ? ` || (CASE WHEN coalesce(jsonb_typeof(tr.a -> 2 -> 'timezone'), 'null') = 'null' ` +
      `AND (${x} -> 'offsetSeconds') IS NOT NULL THEN jsonb_build_object('timezone', ${x} -> 'timezone') ` +
      `ELSE '{}'::jsonb END)`
    : '';
  const map =
    `jsonb_build_object(${bases.join(', ')}) || ` +
    `(CASE WHEN jsonb_typeof(tr.a -> 2) = 'object' THEN tr.a -> 2 ELSE '{}'::jsonb END)${zone}`;
  return (
    `(SELECT ${postgresTemporalCall(kind, `jsonb_build_array(${map})`)} ` +
    `FROM ${stage(`SELECT (${args}) AS a`, 'tr')}, ${stage(`SELECT ${local} AS l`, 't')} ` +
    `WHERE coalesce(jsonb_typeof(${x}), 'null') <> 'null' AND coalesce(jsonb_typeof(tr.a -> 0), 'null') <> 'null')`
  );
}

/**
 * A stage of the chain: a LATERAL subquery that computes its columns once.
 * `OFFSET 0` keeps PostgreSQL from pulling it up into the next stage, which
 * would copy each column's expression into every use of it.
 */
export function stage(sql: string, alias: string): string {
  return `LATERAL (${sql} OFFSET 0) ${alias}`;
}
