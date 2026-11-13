// Durations and temporal arithmetic of values known only at run time, in
// PostgreSQL SQL: the rules of src/duration.ts. Exact `numeric` arithmetic
// replaces TypeScript's floats for fractions. Temporal results are built by the
// temporal pipeline (postgresTemporalCall) from a map of fields.

import { TEMPORAL_KINDS } from '../temporal.js';
import { CALENDAR, fail, offsetAtLocal, renderAnyKind, stage } from './postgres-temporal.js';

const DAY = '86400000000000';
const TEMPORAL_TYPES = `(${TEMPORAL_KINDS.map((k) => `'${k}'`).join(', ')})`;
const SECONDS_PER_MONTH = 2629746;
const pad = (n: string, width: number): string => `lpad((${n})::text, ${width}, '0')`;

/** Fails with a type error (see plan.ts). */
const typeFail = (message: string): string =>
  `(('cypher temporal type error: ' || ${message} || substr(random()::text, 1, 0))::int)`;

/**
 * The tagged JSON of a duration from bigint columns `u.m` (months), `u.d`
 * (days), `u.s` (seconds), `u.n` (0 to 999,999,999), and stage `g` (TEXT_PARTS).
 */
const RENDER = ((): string => {
  const neg = `g.neg`;
  const s = `g.s`;
  const n = `g.n`;
  const rest = `(${s} % 60)`;
  const seconds =
    `(CASE WHEN ${rest} <> 0 OR ${n} <> 0 THEN ` +
    `(CASE WHEN ${rest} = 0 AND (${neg} OR ${s} < 0) AND ${n} <> 0 THEN '-' ELSE '' END) || ${rest} || ` +
    `(CASE WHEN ${n} <> 0 THEN '.' || rtrim(${pad(n, 9)}, '0') ELSE '' END) || 'S' ELSE '' END)`;
  const time =
    `(CASE WHEN ${s} <> 0 OR ${n} <> 0 THEN 'T' || ` +
    `(CASE WHEN ${s} / 3600 <> 0 THEN (${s} / 3600) || 'H' ELSE '' END) || ` +
    `(CASE WHEN ${s} / 60 % 60 <> 0 THEN (${s} / 60 % 60) || 'M' ELSE '' END) || ${seconds} ELSE '' END)`;
  const text =
    `'P' || (CASE WHEN u.m / 12 <> 0 THEN (u.m / 12) || 'Y' ELSE '' END) || ` +
    `(CASE WHEN u.m % 12 <> 0 THEN (u.m % 12) || 'M' ELSE '' END) || ` +
    `(CASE WHEN u.d <> 0 THEN u.d || 'D' ELSE '' END) || ${time}`;
  return (
    `jsonb_build_object('~cypher', 'duration', '~s', (CASE WHEN (${text}) = 'P' THEN 'PT0S' ELSE ${text} END), ` +
    `'years', u.m / 12, 'quarters', u.m / 3, 'months', u.m, 'weeks', u.d / 7, 'days', u.d, ` +
    `'hours', u.s / 3600, 'minutes', u.s / 60, 'seconds', u.s, ` +
    `'milliseconds', u.s * 1000 + u.n / 1000000, 'microseconds', u.s * 1000000 + u.n / 1000, ` +
    `'nanoseconds', u.s::numeric * 1000000000 + u.n, 'quartersOfYear', u.m / 3 % 4, ` +
    `'monthsOfQuarter', u.m % 3, 'monthsOfYear', u.m % 12, 'daysOfWeek', u.d % 7, ` +
    `'minutesOfHour', u.s / 60 % 60, 'secondsOfMinute', u.s % 60, ` +
    `'millisecondsOfSecond', u.n / 1000000, 'microsecondsOfSecond', u.n / 1000, 'nanosecondsOfSecond', u.n)`
  );
})();

/**
 * Stages `c`, `u`, and `g` that turn numeric amounts `mo` (months), `dy`
 * (days), and `na` (nanoseconds, whole) of stage `w` into a duration: a
 * fraction of a month becomes days and seconds, a fraction of a day seconds
 * (see durationOf). `g` holds the seconds and nanos as the text writes them
 * (-60.001 is -60 and 0.001, `neg`).
 */
const CASCADE = [
  stage(
    `SELECT trunc(w.mo) AS wm, (w.mo - trunc(w.mo)) * ${SECONDS_PER_MONTH} AS ms, trunc(w.dy) AS wd, w.dy, w.na`,
    'c',
  ),
  stage(
    `SELECT p.m, p.d, floor(p.t / 1000000000)::bigint AS s, ` +
      `(p.t - floor(p.t / 1000000000) * 1000000000)::bigint AS n FROM (SELECT c.wm::bigint AS m, ` +
      `(c.wd + trunc(c.ms / 86400))::bigint AS d, ` +
      `round(((c.ms - trunc(c.ms / 86400) * 86400) + (c.dy - c.wd) * 86400) * 1000000000) + c.na AS t) p`,
    'u',
  ),
  stage(
    `SELECT q.neg, u.s + (CASE WHEN q.neg THEN 1 ELSE 0 END) AS s, ` +
      `(CASE WHEN q.neg THEN 1000000000 - u.n ELSE u.n END) AS n FROM (SELECT u.s < 0 AND u.n > 0 AS neg) q`,
    'g',
  ),
].join(', ');

/** A duration's tagged JSON from SQL amounts (numeric months, days, and nanoseconds). */
function durationOf(
  months: string,
  days: string,
  nanos: string,
  from: string,
  where = 'TRUE',
): string {
  return `(SELECT ${RENDER} FROM ${from}, ${stage(
    `SELECT (${months})::numeric AS mo, (${days})::numeric AS dy, ` + `(${nanos})::numeric AS na`,
    'w',
  )}, ${CASCADE} WHERE ${where})`;
}

const NUMBER = '([+-]?\\d+(?:[.,]\\d+)?)';
const ISO =
  `^([+-])?P(?:${NUMBER}Y)?(?:${NUMBER}M)?(?:${NUMBER}W)?(?:${NUMBER}D)?` +
  `(?:T(?:${NUMBER}H)?(?:${NUMBER}M)?(?:${NUMBER}S)?)?$`;
const ALTERNATIVE = '^([+-])?P(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2}(?:[.,]\\d+)?)$';

/** `duration(x)` for a string, a map, or a duration `x` (JSON). */
function construct(x: string): string {
  const key = (k: string): string => `coalesce((${x} ->> '${k}')::numeric, 0)`;
  const g = (i: number): string => `coalesce(replace(p.r[${i}], ',', '.'), '0')::numeric`;
  // Amounts in order: years, months, weeks, days, hours, minutes, seconds, sign.
  const fromString =
    `SELECT CASE WHEN p.r IS NOT NULL THEN ARRAY[${g(2)}, ${g(3)}, ${g(4)}, ${g(5)}, ${g(6)}, ${g(7)}, ${g(8)}, ` +
    `(CASE WHEN p.r[1] = '-' THEN -1 ELSE 1 END)] ` +
    `WHEN p.alt IS NOT NULL THEN ARRAY[${[2, 3, 0, 4, 5, 6, 7].map((i) => (i === 0 ? '0' : `replace(p.alt[${i}], ',', '.')::numeric`)).join(', ')}, ` +
    `(CASE WHEN p.alt[1] = '-' THEN -1 ELSE 1 END)] ` +
    `ELSE ${fail(`'Invalid duration: ' || p.t`)}::text::numeric[] END AS v ` +
    `FROM (SELECT q.t, (CASE WHEN q.t = 'P' OR q.t LIKE '%T' THEN NULL ELSE regexp_match(q.t, '${ISO}') END) AS r, ` +
    `regexp_match(q.t, '${ALTERNATIVE}') AS alt FROM (SELECT ${x} #>> '{}' AS t) q) p`;
  const fromMap =
    `SELECT ARRAY[${key('years')} * 12 + ${key('quarters')} * 3 + ${key('months')}, ` +
    `${key('weeks')} * 7 + ${key('days')}, ${key('hours')} * 3600000000000 + ${key('minutes')} * 60000000000 + ` +
    `${key('seconds')} * 1000000000 + ${key('milliseconds')} * 1000000 + ${key('microseconds')} * 1000 + ` +
    `${key('nanoseconds')}] AS v`;
  const amounts =
    `(CASE jsonb_typeof(${x}) WHEN 'string' THEN (SELECT ARRAY[(s.v[1] * 12 + s.v[2]) * s.v[8], ` +
    `(s.v[3] * 7 + s.v[4]) * s.v[8], (s.v[5] * 3600 + s.v[6] * 60 + s.v[7]) * 1000000000 * s.v[8]] ` +
    `FROM (${fromString}) s) ` +
    `WHEN 'object' THEN (SELECT m.v FROM (${fromMap}) m) ` +
    `ELSE ${fail(`'Invalid argument for duration()'`)}::text::numeric[] END)`;
  return (
    `(CASE WHEN ${x} ->> '~cypher' = 'duration' THEN ${x} ELSE ` +
    durationOf('z.v[1]', 'z.v[2]', 'round(z.v[3])', stage(`SELECT ${amounts} AS v`, 'z')) +
    ' END)'
  );
}

// ---- between -------------------------------------------------------------------

/** `duration.between(a, b)` and its `inMonths`, `inDays`, `inSeconds` forms, of JSON `a` and `b`. */
function between(unit: string, a: string, b: string): string {
  const side = (t: string, p: string): string =>
    `(${t} -> 'year') IS NOT NULL AS ${p}hd, ` +
    `(CASE WHEN (${t} -> 'year') IS NOT NULL THEN make_date((${t} ->> 'year')::int, (${t} ->> 'month')::int, ` +
    `(${t} ->> 'day')::int) END) AS ${p}dt, ` +
    `coalesce(((${t} ->> 'hour')::bigint * 3600 + (${t} ->> 'minute')::bigint * 60 + ` +
    `(${t} ->> 'second')::bigint) * 1000000000 + (${t} ->> 'nanosecond')::bigint, 0) AS ${p}ns, ` +
    `(${t} ->> 'offsetSeconds')::int AS ${p}off, ` +
    `(CASE WHEN (${t} ->> 'timezone') !~ '^[+-]' THEN ${t} ->> 'timezone' END) AS ${p}zone`;
  const local = (date: string, ns: string): string =>
    `(${date} + make_interval(secs => ${ns} / 1000000000.0))::timestamp`;
  // A side without a zone is read in the other's zone.
  const fill = (p: string, o: string): string =>
    `coalesce(s.${p}off, (CASE WHEN s.${o}off IS NOT NULL THEN (CASE WHEN s.${o}zone IS NOT NULL THEN ` +
    `${offsetAtLocal(`s.${o}zone`, local(`coalesce(s.${p}dt, s.${o}dt, DATE '1970-01-01')`, `s.${p}ns`))} ` +
    `ELSE s.${o}off END) END))`;
  const months =
    `((extract(year FROM e.ed)::bigint * 12 + extract(month FROM e.ed)::bigint - 1) * 32 + extract(day FROM e.ed)::bigint ` +
    `- ((extract(year FROM s.adt)::bigint * 12 + extract(month FROM s.adt)::bigint - 1) * 32 + extract(day FROM s.adt)::bigint)) / 32`;
  const result: Record<string, [string, string, string]> = {
    between: [
      'k.mo',
      '(e.ed - k.sh)',
      'r.total - ((k.sh - s.adt) + (e.ed - k.sh))::numeric * ' + DAY,
    ],
    inMonths: ['k.mo', '0', '0'],
    inDays: ['0', '(e.ed - s.adt)', '0'],
    inSeconds: ['0', '0', 'r.total'],
  };
  const [mo, dy, na] = result[unit]!;
  const timeOnly: [string, string, string] =
    unit === 'inMonths' || unit === 'inDays' ? ['0', '0', '0'] : ['0', '0', 'r.total'];
  const from = [
    stage(`SELECT ${side(a, 'a')}, ${side(b, 'b')}`, 's'),
    stage(`SELECT ${fill('a', 'b')} AS aoff, ${fill('b', 'a')} AS boff`, 'z'),
    stage(
      `SELECT s.bns + coalesce((z.aoff - z.boff)::bigint * 1000000000, 0) AS nb, s.ahd AND s.bhd AS dated`,
      'q',
    ),
    stage(
      `SELECT (CASE WHEN q.dated THEN s.bdt + floor(q.nb / ${DAY}.0)::int END) AS bdt, ` +
        `(CASE WHEN q.dated THEN ((q.nb % ${DAY}) + ${DAY}) % ${DAY} ELSE q.nb END) AS bns`,
      'b2',
    ),
    stage(
      `SELECT (CASE WHEN q.dated THEN (b2.bdt - s.adt)::numeric * ${DAY} ELSE 0 END) + b2.bns - s.ans AS total`,
      'r',
    ),
    stage(
      `SELECT b2.bdt + (CASE WHEN b2.bdt > s.adt AND b2.bns < s.ans THEN -1 ` +
        `WHEN b2.bdt < s.adt AND b2.bns > s.ans THEN 1 ELSE 0 END) AS ed`,
      'e',
    ),
    stage(
      `SELECT m.mo, (s.adt + make_interval(months => m.mo::int))::date AS sh FROM (SELECT ${months} AS mo) m`,
      'k',
    ),
  ].join(', ');
  return (
    `(CASE WHEN coalesce(jsonb_typeof(${a}), 'null') = 'null' OR coalesce(jsonb_typeof(${b}), 'null') = 'null' THEN NULL ` +
    `WHEN NOT (${a} ->> '~cypher' IN ${TEMPORAL_TYPES} AND ${b} ->> '~cypher' IN ${TEMPORAL_TYPES}) ` +
    `THEN ${fail(`'Invalid argument for duration.${unit}()'`)}::text::jsonb ` +
    `ELSE (SELECT CASE WHEN q.dated THEN ${durationOf(mo, dy, na, '(SELECT 1) one')} ` +
    `ELSE ${durationOf(...timeOnly, '(SELECT 1) one')} END FROM ${from}) END)`
  );
}

/** `duration(...)`, `duration.between(...)` and its forms, of the JSON array `args`. */
export function postgresDurationCall(name: string, args: string): string {
  const units: Record<string, string> = {
    'duration.between': 'between',
    'duration.inmonths': 'inMonths',
    'duration.indays': 'inDays',
    'duration.inseconds': 'inSeconds',
  };
  const unit = units[name];
  return (
    `(SELECT ${unit ? between(unit, 'da.a -> 0', 'da.a -> 1') : construct('(da.a -> 0)')} ` +
    `FROM ${stage(`SELECT (${args}) AS a`, 'da')} ` +
    `WHERE ${unit ? 'TRUE' : `coalesce(jsonb_typeof(da.a -> 0), 'null') <> 'null'`})`
  );
}

// ---- arithmetic ----------------------------------------------------------------

/**
 * A temporal value `t` plus `sign` times duration `d` (JSON): one pipeline for
 * every kind. Months (the day clamped by PostgreSQL's month arithmetic), then
 * days, then the time on the local value; a date takes whole days of the time
 * toward zero, a time only the time. A named zone's offset is taken at the new
 * local time.
 */
function addToTemporal(t: string, d: string, sign: string): string {
  const inputs =
    `SELECT ${t} ->> '~cypher' AS kind, ${t} AS t, ${sign} * (${d} ->> 'months')::int AS mo, ` +
    `${sign} * (${d} ->> 'days')::int AS dy, ${sign} * ((${d} ->> 'seconds')::numeric * 1000000000 + ` +
    `(${d} ->> 'nanosecondsOfSecond')::numeric) AS na, ` +
    `coalesce(((${t} ->> 'hour')::numeric * 3600 + (${t} ->> 'minute')::numeric * 60 + ` +
    `(${t} ->> 'second')::numeric) * 1000000000 + (${t} ->> 'nanosecond')::numeric, 0) AS tns, ` +
    `(CASE WHEN (${t} -> 'year') IS NOT NULL THEN make_date((${t} ->> 'year')::int, (${t} ->> 'month')::int, ` +
    `(${t} ->> 'day')::int) END) AS bd`;
  const local =
    `SELECT (CASE WHEN s.bd IS NULL THEN NULL WHEN s.kind = 'date' ` +
    `THEN (s.bd + make_interval(months => s.mo))::date + s.dy + trunc(s.na / ${DAY})::int ` +
    `ELSE (s.bd + make_interval(months => s.mo))::date + s.dy + floor((s.tns + s.na) / ${DAY})::int END) AS dt, ` +
    `(CASE WHEN s.kind = 'date' THEN 0 ELSE mod(mod(s.tns + s.na, ${DAY}) + ${DAY}, ${DAY}) END)::bigint AS ns`;
  const zoneName = `(s.t ->> 'timezone')`;
  const zone =
    `SELECT (CASE WHEN s.kind = 'datetime' AND ${zoneName} !~ '^[+-]' ` +
    `THEN ${offsetAtLocal(zoneName, `(v.dt + make_interval(secs => v.ns / 1000000000.0))::timestamp`)} ` +
    `ELSE coalesce((s.t ->> 'offsetSeconds')::int, 0) END) AS off, ` +
    `(CASE WHEN s.kind = 'datetime' AND ${zoneName} !~ '^[+-]' THEN ${zoneName} END) AS zone`;
  const rendered = renderAnyKind('s.kind');
  return (
    `(SELECT ${rendered.json} FROM ${stage(inputs, 's')}, ${stage(local, 'v')}, ` +
    `${stage(zone, 'y')}, ${stage(CALENDAR, 'c')}, ${stage(rendered.stage, 'x')})`
  );
}

/** `l op r` on JSON values of which one is a temporal value or duration (see Dialect.temporalArithmetic). */
export function postgresTemporalArithmetic(op: string, l: string, r: string): string {
  const tag = (j: string): string => `(${j} ->> '~cypher')`;
  const isDuration = (j: string): string => `${tag(j)} = 'duration'`;
  const isTemporal = (j: string): string => `${tag(j)} IN ${TEMPORAL_TYPES}`;
  const isNumber = (j: string): string => `jsonb_typeof(${j}) = 'number'`;
  const total = (j: string): string =>
    `((${j} ->> 'seconds')::numeric * 1000000000 + (${j} ->> 'nanosecondsOfSecond')::numeric)`;
  const scaled = (d: string, factor: string): string =>
    durationOf(
      `(${d} ->> 'months')::numeric * ${factor}`,
      `(${d} ->> 'days')::numeric * ${factor}`,
      `trunc(${total(d)} * ${factor})`,
      '(SELECT 1) one',
    );
  const arms: string[] = [];
  if (op === '+' || op === '-') {
    const sign = op === '+' ? '1' : '-1';
    if (op === '+') {
      // Either order: one pipeline, with the temporal value picked at run time.
      const t = `(CASE WHEN ${isTemporal(l)} THEN ${l} ELSE ${r} END)`;
      const d = `(CASE WHEN ${isTemporal(l)} THEN ${r} ELSE ${l} END)`;
      arms.push(
        `WHEN (${isTemporal(l)} AND ${isDuration(r)}) OR (${isDuration(l)} AND ${isTemporal(r)}) ` +
          `THEN ${addToTemporal(t, d, sign)}`,
      );
    } else {
      arms.push(`WHEN ${isTemporal(l)} AND ${isDuration(r)} THEN ${addToTemporal(l, r, sign)}`);
    }
    arms.push(
      `WHEN ${isDuration(l)} AND ${isDuration(r)} THEN ` +
        durationOf(
          `(${l} ->> 'months')::numeric ${op} (${r} ->> 'months')::numeric`,
          `(${l} ->> 'days')::numeric ${op} (${r} ->> 'days')::numeric`,
          `${total(l)} ${op} ${total(r)}`,
          '(SELECT 1) one',
        ),
    );
  }
  if (op === '*') {
    arms.push(
      `WHEN ${isDuration(l)} AND ${isNumber(r)} THEN ${scaled(l, `(${r})::text::numeric`)}`,
    );
    arms.push(
      `WHEN ${isNumber(l)} AND ${isDuration(r)} THEN ${scaled(r, `(${l})::text::numeric`)}`,
    );
  }
  if (op === '/') {
    arms.push(
      `WHEN ${isDuration(l)} AND ${isNumber(r)} THEN (CASE WHEN (${r})::text::numeric = 0 ` +
        `THEN ${fail(`'Division by zero'`)}::text::jsonb ELSE ${scaled(l, `(1 / (${r})::text::numeric)`)} END)`,
    );
  }
  const mismatch = `${typeFail(`'Type mismatch: cannot apply \`${op}\` to these values'`)}::text::jsonb`;
  return arms.length === 0 ? mismatch : `(CASE ${arms.join(' ')} ELSE ${mismatch} END)`;
}
