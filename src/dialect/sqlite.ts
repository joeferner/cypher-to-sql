import { UnsupportedFeatureError } from '../errors.js';
import { parseCypherJson, stringifyCypherJson } from '../json.js';
import { TemporalError } from '../temporal.js';
import { callTemporal, temporalArithmetic, TypeMismatch } from '../temporal-functions.js';
import type { CypherValue } from '../values.js';
import {
  ENTITY_TAG,
  entityFields,
  javaFloatText,
  sqlStringLiteral,
  type Dialect,
  type EntityColumns,
  type ScalarType,
} from './dialect.js';

/** An entity's tagged object: its properties with the reserved keys added. */
function entityObject(kind: 'node' | 'relationship', alias: string, table: EntityColumns): string {
  const fields = entityFields(kind, alias, table, (c) => `json(${c})`);
  return `json_patch(${alias}.${table.properties}, json_object(${fields.flat().join(', ')}))`;
}

export interface SqliteOptions {
  /**
   * Use the functions that `registerSqliteFunctions` adds to the connection
   * (default false). Without them, `toUpper` and `toLower` change ASCII
   * letters only, because SQLite's `upper()` and `lower()` do (unless the ICU
   * extension is loaded); with them, they follow Unicode, as in Cypher. `=~`
   * needs them too.
   */
  functions?: boolean;
}

/** A connection that can define SQL functions: better-sqlite3 or `node:sqlite`. */
export interface SqliteFunctionHost {
  function(
    name: string,
    options: { deterministic: boolean },
    fn: (...args: unknown[]) => unknown,
  ): unknown;
}

/**
 * Registers the functions that `sqlite({ functions: true })` uses on a
 * better-sqlite3 `Database` or a `node:sqlite` `DatabaseSync`. Call it once per
 * connection, before running queries.
 */
export function registerSqliteFunctions(db: SqliteFunctionHost): void {
  const options = { deterministic: true };
  db.function('cypher_upper', options, (s) => (typeof s === 'string' ? s.toUpperCase() : s));
  db.function('cypher_lower', options, (s) => (typeof s === 'string' ? s.toLowerCase() : s));
  db.function('cypher_regex', options, (s, p) =>
    typeof s === 'string' && typeof p === 'string' ? Number(javaRegex(p).test(s)) : null,
  );
  // Not deterministic: date() without arguments is the current date.
  db.function('cypher_temporal', { deterministic: false }, (name, args) => {
    try {
      const values = parseCypherJson(String(args)) as CypherValue[];
      return stringifyCypherJson(callTemporal(String(name), values));
    } catch (error) {
      throw error instanceof TemporalError
        ? new Error(`cypher temporal error: ${error.message}`)
        : error;
    }
  });
  db.function('cypher_temporal_op', { deterministic: true }, (op, left, right) => {
    try {
      const value = (json: unknown): CypherValue => parseCypherJson(String(json));
      return stringifyCypherJson(temporalArithmetic(String(op), value(left), value(right)));
    } catch (error) {
      if (error instanceof TypeMismatch) {
        throw new Error(`cypher temporal type error: ${error.message}`, { cause: error });
      }
      throw error instanceof TemporalError
        ? new Error(`cypher temporal error: ${error.message}`)
        : error;
    }
  });
}

const regexCache = new Map<string, RegExp>();

/**
 * A JavaScript RegExp for a Java regular expression (Cypher's syntax) that
 * must match a whole string. Java's leading embedded flags `(?ims)` become
 * RegExp flags. The lookarounds anchor at the ends of the string whatever the
 * flags (JavaScript has no `\A` or `\z`). The `u` flag makes `.` match a code
 * point, as in Java; a pattern that `u` rejects (such as `\-` outside a
 * class, which Java allows) is compiled without it. Other Java syntax that
 * JavaScript lacks (possessive quantifiers, atomic groups, `\Q...\E`, flags
 * inside the pattern) is an invalid regular expression.
 */
function javaRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }
  const leading = /^\(\?([a-zA-Z]*)\)/.exec(pattern);
  const javaFlags = leading?.[1] ?? '';
  if (/[^imsud]/.test(javaFlags)) {
    throw new SyntaxError(`Invalid regular expression: flags (?${javaFlags}) are not supported`);
  }
  const flags = [...'ims'].filter((f) => javaFlags.includes(f)).join('');
  const source = `(?<![\\s\\S])(?:${pattern.slice(leading?.[0].length ?? 0)})(?![\\s\\S])`;
  let regex: RegExp;
  try {
    regex = new RegExp(source, `${flags}u`);
  } catch {
    try {
      regex = new RegExp(source, flags);
    } catch (error) {
      // The message names the rewritten source; name the pattern as written.
      const reason = (error as Error).message.replace(/^.*\/: /, '');
      throw new SyntaxError(`Invalid regular expression ${JSON.stringify(pattern)}: ${reason}`, {
        cause: error,
      });
    }
  }
  if (regexCache.size >= 256) {
    regexCache.clear();
  }
  regexCache.set(pattern, regex);
  return regex;
}

/**
 * SQLite dialect. Requires SQLite 3.38 or newer for the `->` JSON operator, and
 * the math functions (`pow`, `trunc`; on by default in most builds) for `^` and
 * float `%`. JSON values are JSON text; booleans are the integers 1 and 0.
 */
export function sqlite(options: SqliteOptions = {}): Dialect {
  return {
    name: 'sqlite',
    quoteIdent: (name) => `"${name}"`,
    placeholder: () => '?',
    numberedPlaceholders: false,
    returning: true,
    nullsOrder: true,
    limitExpressions: true,
    // SQLite allows several recursive SELECTs, but its OR join uses both indexes.
    recursiveBranches: false,
    integerText: (integer) => `CAST(${integer} AS TEXT)`,
    integerDivide: (dividend, divisor) => `(${dividend} / ${divisor})`,
    floatRemainder: (dividend, divisor) =>
      `(${dividend} - trunc(${dividend} / ${divisor}) * ${divisor})`,
    jsonInput: (placeholder) => placeholder,
    jsonText: (expr) => expr,
    jsonMember: (objectExpr, keyPlaceholder, key): string => {
      // SQL injection: the key is a bind value; the path is assembled by SQLite at
      // run time as string data, never as SQL text.
      // JSON-path injection: inside a quoted path label SQLite has no escape for
      // `"`, so a key containing one would address a different member. Reject it.
      if (key.includes('"')) {
        throw new UnsupportedFeatureError(
          `Property keys containing '"' are not supported on SQLite: ${JSON.stringify(key)}`,
          { hint: 'Rename the property so that its key has no double quote.' },
        );
      }
      return `(${objectExpr} -> ('$."' || ${keyPlaceholder} || '"'))`;
    },
    // `->>` returns the SQL value: INTEGER, REAL, TEXT, or 1/0 for booleans. An
    // index on `(properties ->> '$."key"')` matches this expression.
    typedMember: (objectExpr, key) => `(${objectExpr} ->> ${sqlStringLiteral(`$."${key}"`)})`,
    hasLabel: (labelsExpr, labelPlaceholder) =>
      `EXISTS (SELECT 1 FROM json_each(${labelsExpr}) WHERE json_each.value = ${labelPlaceholder})`,
    mergeProperties: (properties, patch) => `json_patch(${properties}, ${patch})`,
    appendLabel: (labels, label) => `json_insert(${labels}, '$[#]', ${label})`,
    removeLabel: (labels, label) =>
      `(SELECT json_group_array(json_each.value) FROM json_each(${labels}) ` +
      `WHERE json_each.value <> ${label})`,
    typedPlaceholder: (placeholder, type) =>
      type === 'float' ? `CAST(${placeholder} AS REAL)` : placeholder,
    booleanLiteral: (value) => (value === null ? 'NULL' : value ? '1' : '0'),
    jsonType: (json) =>
      `(CASE json_type(${json}) WHEN 'integer' THEN 'integer' WHEN 'real' THEN 'float' ` +
      `WHEN 'text' THEN 'string' WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean' ` +
      `WHEN 'array' THEN 'list' WHEN 'object' THEN ` +
      `COALESCE(json_extract(${json}, '$."${ENTITY_TAG}"'), 'map') WHEN 'null' THEN 'null' END)`,
    jsonIsNull: (json) => `(COALESCE(json_type(${json}), 'null') = 'null')`,
    fromJson: (json) => `(${json} ->> '$')`,
    toJson,
    floatToString,
    changeCase: (string, to) =>
      options.functions ? `cypher_${to}(${string})` : `${to}(${string})`,
    // json() marks JSON text as JSON, so that it is nested rather than quoted.
    jsonSetKey: (object, keyPlaceholder, key, value): string => {
      // As in jsonMember: a `"` in the key would address another member.
      if (key.includes('"')) {
        throw new UnsupportedFeatureError(
          `Map keys containing '"' are not supported on SQLite here: ${JSON.stringify(key)}`,
        );
      }
      return `json_set(${object}, '$."' || ${keyPlaceholder} || '"', json(${value}))`;
    },
    jsonArray: (items) => `json_array(${items.map((item) => `json(${item})`).join(', ')})`,
    jsonObject: (entries) =>
      `json_object(${entries.map((e) => `${e.keyPlaceholder}, json(${e.value})`).join(', ')})`,
    listLength: (json) => `json_array_length(${json})`,
    // The default BINARY collation compares by bytes, which is code point order in UTF-8.
    compareStrings: (left, operator, right) => `(${left} ${operator} ${right})`,
    orderString: (string) => string,
    // Not LIKE: it is case-insensitive for ASCII and treats % and _ as wildcards.
    startsWith: (string, prefix) => `(substr(${string}, 1, length(${prefix})) = ${prefix})`,
    endsWith: (string, suffix) =>
      `(CASE WHEN ${string} IS NULL OR ${suffix} IS NULL THEN NULL ` +
      `WHEN length(${suffix}) = 0 THEN 1 ELSE substr(${string}, -length(${suffix})) = ${suffix} END)`,
    contains: (string, part) => `(instr(${string}, ${part}) > 0)`,
    regexMatch: options.functions
      ? (string, pattern): string => `cypher_regex(${string}, ${pattern})`
      : undefined,
    temporalCall: options.functions
      ? (name, args): string => `cypher_temporal(${sqlStringLiteral(name)}, ${args})`
      : undefined,
    temporalArithmetic: options.functions
      ? (op, left, right): string =>
          `cypher_temporal_op(${sqlStringLiteral(op)}, ${left}, ${right})`
      : undefined,
    power: (base, exponent) => `pow(${base}, ${exponent})`,
    // ORDER BY inside an aggregate needs SQLite 3.44 or newer.
    jsonAggregate: (value, { distinct, orderBy, filter }) =>
      `json_group_array(${distinct ? 'DISTINCT ' : ''}json(${value})` +
      `${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''}) FILTER (WHERE ${filter})`,
    booleanAggregate: (kind, value) => `${kind}(${value})`,
    stringAggregate: (value, orderBy) =>
      `group_concat(${value}, ''${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''})`,
    // Sign class, a biased decimal exponent, and the mantissa in [1, 10) (for
    // negative numbers both complemented, so that larger magnitudes sort first).
    sortableNumber: (value) =>
      `(SELECT CASE WHEN f = 0 THEN 'M' WHEN f > 1.7976931348623157e308 THEN 'O' ` +
      `WHEN f < -1.7976931348623157e308 THEN 'K' ` +
      `WHEN f > 0 THEN 'N' || printf('%03d', e + 400) || printf('%.15f', abs(f) / pow(10, e)) ` +
      `ELSE 'L' || printf('%03d', 599 - e) || printf('%.15f', 10 - abs(f) / pow(10, e)) END ` +
      `FROM (SELECT f, max(CASE WHEN abs(f) / pow(10, e0) >= 10 THEN e0 + 1 ` +
      `WHEN abs(f) / pow(10, e0) < 1 THEN e0 - 1 ELSE e0 END, -300) AS e ` +
      `FROM (SELECT f, max(CAST(floor(log10(CASE WHEN f = 0 OR abs(f) > 1.7976931348623157e308 THEN 1 ELSE abs(f) END)) AS INTEGER), -300) AS e0 ` +
      `FROM (SELECT (${value}) AS f))))`,
    // char(1) is escaped as char(1, 2) and the terminator is char(1, 1).
    sortableString: (string) => `(replace(${string}, char(1), char(1, 2)) || char(1, 1))`,
    jsonRemoveKeys: (map, keys) =>
      `json_remove(${map}, ${keys.map((k) => sqlStringLiteral(`$."${k}"`)).join(', ')})`,
    jsonKeys: (map) =>
      `(SELECT json_group_array(key) FROM (SELECT key FROM json_each(${map}) ORDER BY key))`,
    // A JSON path built from the key could address another member (SQLite paths
    // have no escape for `"`), so the key is compared as data instead.
    jsonMemberAt: (object, key) =>
      `(SELECT ${elementJson('jm')} FROM json_each(${object}) AS jm ` +
      `WHERE json_type(${object}) = 'object' AND jm.key = ${key})`,
    // `$[#-1]` is the last element.
    jsonElement: (list, index) =>
      `(${list} -> ('$[' || CASE WHEN ${index} < 0 THEN '#' || ${index} ELSE ${index} END || ']'))`,
    jsonTail: (list) => `json_remove(${list}, '$[0]')`,
    reverseList: (list) =>
      `(SELECT json_group_array(json(v)) FROM (SELECT ${elementJson('rv')} AS v ` +
      `FROM json_each(${list}) AS rv ORDER BY rv.key DESC))`,
    reverseString: (string) =>
      `(WITH RECURSIVE rs(i, s) AS (SELECT length(${string}), '' UNION ALL ` +
      `SELECT i - 1, s || substr(${string}, i, 1) FROM rs WHERE i > 0) SELECT s FROM rs WHERE i = 0)`,
    range: (start, end, step) =>
      `(WITH RECURSIVE rg(v) AS (SELECT ${start} UNION ALL SELECT v + ${step} FROM rg ` +
      `WHERE (${step} > 0 AND v + ${step} <= ${end}) OR (${step} < 0 AND v + ${step} >= ${end})) ` +
      `SELECT json_group_array(v) FROM rg WHERE (${step} > 0 AND v <= ${end}) OR (${step} < 0 AND v >= ${end}))`,
    // An empty delimiter does not split (it would never advance).
    split: (string, delimiter) =>
      `(WITH RECURSIVE sp(i, part, rest) AS (SELECT 0, NULL, ${string} UNION ALL ` +
      `SELECT i + 1, CASE WHEN ${delimiter} <> '' AND instr(rest, ${delimiter}) > 0 ` +
      `THEN substr(rest, 1, instr(rest, ${delimiter}) - 1) ELSE rest END, ` +
      `CASE WHEN ${delimiter} <> '' AND instr(rest, ${delimiter}) > 0 ` +
      `THEN substr(rest, instr(rest, ${delimiter}) + length(${delimiter})) END ` +
      `FROM sp WHERE rest IS NOT NULL) ` +
      `SELECT json_group_array(part) FROM (SELECT part FROM sp WHERE i > 0 ORDER BY i))`,
    stringLength: (string) => `length(${string})`,
    substring: (string, start, length) =>
      `substr(${string}, ${start} + 1${length === undefined ? '' : `, ${length}`})`,
    // substr(s, -0) would return the whole string.
    rightString: (string, count) =>
      `(CASE WHEN ${count} = 0 THEN '' ELSE substr(${string}, -(${count})) END)`,
    // A number is valid JSON whose type is integer or real (so `+1` and `.5` are not numbers).
    parseNumber: (string, type): string => {
      const t = `trim(${string})`;
      const real =
        type === 'integer' ? `CAST(CAST(${t} AS REAL) AS INTEGER)` : `CAST(${t} AS REAL)`;
      const int = type === 'integer' ? `CAST(${t} AS INTEGER)` : `CAST(${t} AS REAL)`;
      return (
        `(CASE WHEN json_valid(${t}) THEN CASE json_type(${t}) ` +
        `WHEN 'integer' THEN ${int} WHEN 'real' THEN ${real} END END)`
      );
    },
    toFloat: (number) => `CAST(${number} AS REAL)`,
    truncate: (float) => `CAST(${float} AS INTEGER)`,
    math: (name, args): string => {
      switch (name) {
        case 'log':
          return `ln(${args[0]})`;
        case 'e':
          return 'exp(1)';
        case 'pi':
          return 'pi()';
        case 'rand':
          return '(abs(random()) / 9223372036854775808.0)';
        case 'floor':
        case 'ceil':
          return `CAST(${name}(${args[0]}) AS REAL)`;
        default:
          return `${name}(${args.join(', ')})`;
      }
    },
    // Walks both values in parallel with a recursive CTE: one row per pair of
    // values at the same position, then a three-valued AND over the rows.
    // Scalars are carried as SQL values with their json_each type, so reals
    // compare exactly.
    jsonDeepEquals: (left, right): string => {
      const cls = (t: string): string =>
        `CASE ${t} WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' WHEN 'true' THEN 'boolean' ` +
        `WHEN 'false' THEN 'boolean' ELSE ${t} END`;
      const pair =
        `CASE WHEN COALESCE(at, 'null') = 'null' OR COALESCE(bt, 'null') = 'null' THEN NULL ` +
        `WHEN ${cls('at')} <> ${cls('bt')} THEN 0 ` +
        `WHEN at = 'array' THEN json_array_length(a) = json_array_length(b) ` +
        `WHEN at = 'object' THEN (SELECT group_concat(key, char(0)) FROM (SELECT key FROM json_each(a) ORDER BY key)) ` +
        `IS (SELECT group_concat(key, char(0)) FROM (SELECT key FROM json_each(b) ORDER BY key)) ` +
        `WHEN at IN ('true', 'false') THEN at = bt ` +
        `ELSE a = b END`;
      const root = (v: string): string =>
        `CASE WHEN json_type(${v}) IN ('array', 'object') THEN ${v} ELSE ${v} ->> '$' END`;
      return (
        `(WITH RECURSIVE w(a, at, b, bt) AS (SELECT ${root(left)}, json_type(${left}), ${root(right)}, json_type(${right}) ` +
        // Only containers are walked; json_each of a scalar SQL value would fail.
        `UNION ALL SELECT x.value, x.type, y.value, y.type FROM w, ` +
        `json_each(CASE WHEN w.at IN ('array', 'object') AND w.at = w.bt THEN w.a END) AS x ` +
        `JOIN json_each(CASE WHEN w.at IN ('array', 'object') AND w.at = w.bt THEN w.b END) AS y ` +
        `ON x.key = y.key) ` +
        `SELECT CASE WHEN SUM(r = 0) > 0 THEN 0 WHEN SUM(r IS NULL) > 0 THEN NULL ELSE 1 END ` +
        `FROM (SELECT ${pair} AS r FROM w))`
      );
    },
    entityJson: entityObject,
    jsonIdEquals: (column, json) => `(${column} = (${json} ->> '$'))`,
    pathJson: (nodes, relationships) =>
      `json_object('${ENTITY_TAG}', 'path', '~nodes', json(${nodes}), '~relationships', json(${relationships}))`,
    entityList: (kind, list, table) =>
      `(CASE WHEN ${list} IS NULL THEN NULL ELSE (SELECT json_group_array(json(` +
      `${entityObject(kind, 've', table)}) ORDER BY vj.key) FROM json_each(${list}) AS vj ` +
      `JOIN ${table.table} AS ve ON ve.${table.id} = vj.value) END)`,
    // JSON arrays of ids.
    idListEmpty: () => 'json_array()',
    idListAppend: (list, id) => `json_insert(${list}, '$[#]', ${id})`,
    idListAggregate: (id, order) => `json_group_array(${id} ORDER BY ${order})`,
    idListHas: (list, id) =>
      `EXISTS (SELECT 1 FROM json_each(${list}) AS vj WHERE vj.value = ${id})`,
    idListsOverlap: (left, right) =>
      `EXISTS (SELECT 1 FROM json_each(${left}) AS vl JOIN json_each(${right}) AS vr ON vl.value = vr.value)`,
    idListLength: (list) => `json_array_length(${list})`,
    selective: (condition) => `likelihood(${condition}, 0.001)`,
    // An invalid JSON path is an error that quotes the path. random() keeps the
    // call from being evaluated once up front.
    raise: (marker) => `json_extract('{}', '${marker}' || substr(random(), 1, 0))`,
    checkedInteger: (expr, overflow) =>
      `(CASE WHEN typeof(${expr}) = 'real' THEN ${overflow} ELSE ${expr} END)`,
    jsonId: (json) => `(${json} ->> '$')`,
    // JSON numbers and strings compare with the id column's affinity.
    boundIdIn: (column, json) => `${column} IN (SELECT value FROM json_each(${json}))`,
    boundPaths: (json) =>
      `SELECT j.value ->> '$.s' AS s, j.value ->> '$.t' AS t, j.value -> '$.r' AS path, ` +
      `j.value -> '$.n' AS nodes FROM json_each(${json}) AS j`,
    // SQLite does not flatten a subquery that has an OFFSET.
    noFlatten: ' LIMIT -1 OFFSET 0',
    limitAll: '-1',
    // 9e999 is infinity in SQLite. NaN becomes NULL in SQLite.
    floatDivide: (dividend, divisor) =>
      `(CASE WHEN ${divisor} = 0 THEN CASE WHEN ${dividend} > 0 THEN 9e999 ` +
      `WHEN ${dividend} < 0 THEN -9e999 END ELSE ${dividend} * 1.0 / ${divisor} END)`,
    isNaN: undefined,
    concatLists: (left, right) =>
      `(SELECT json_group_array(json(v)) FROM (` +
      `SELECT ${elementJson('a')} AS v, 0 AS side, a.key AS k FROM json_each(${left}) AS a ` +
      `UNION ALL SELECT ${elementJson('b')}, 1, b.key FROM json_each(${right}) AS b ` +
      `ORDER BY side, k))`,
    unwind: (listExpr, alias) => ({
      from: `json_each(${listExpr}) AS ${alias}`,
      // json_each of a scalar gives one row with a NULL key. Keep it, except for null.
      where: `NOT (${alias}.key IS NULL AND ${alias}.type = 'null')`,
      value: elementJson(alias),
      order: `${alias}.key`,
      index: `${alias}.key`,
    }),
  };
}

/** JSON text of the element of the json_each row `alias` (`value` is SQL-typed for scalars). */
function elementJson(alias: string): string {
  return (
    `(CASE ${alias}.type WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' ` +
    `WHEN 'false' THEN 'false' WHEN 'array' THEN ${alias}.value ` +
    `WHEN 'object' THEN ${alias}.value WHEN 'real' THEN ${toJson(`${alias}.value`, 'float')} ` +
    `ELSE json_quote(${alias}.value) END)`
  );
}

function toJson(value: string, type: ScalarType): string {
  switch (type) {
    case 'boolean':
      return `(CASE ${value} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END)`;
    case 'integer':
    case 'string':
      return `json_quote(${value})`;
    case 'float':
      return floatToJson(value);
  }
}

/**
 * JSON text of a REAL. json_quote rounds to 15 significant digits, so use the
 * shortest of 15, 16, or 17 digits that reads back as the same double, and
 * add `.0` to integral values so they stay floats. Infinity has no JSON form.
 */
function floatToJson(value: string): string {
  // A subquery computes the value once (it is used many times). Without the
  // `!` flag, printf stops at 16 significant digits.
  const digits = (n: number): string => `printf('%!.${n}g', f)`;
  const shortest =
    `CASE WHEN CAST(${digits(15)} AS REAL) = f THEN ${digits(15)} ` +
    `WHEN CAST(${digits(16)} AS REAL) = f THEN ${digits(16)} ELSE ${digits(17)} END`;
  return (
    `(SELECT CASE WHEN s IS NULL THEN NULL WHEN s GLOB '*[^0-9-]*' THEN s ELSE s || '.0' END ` +
    `FROM (SELECT CASE WHEN f IS NULL OR abs(f) > 1.7976931348623157e308 THEN NULL ` +
    `ELSE ${shortest} END AS s FROM (SELECT ${value} AS f)))`
  );
}

/**
 * A REAL as toString() writes it (see `javaFloatText`). The shortest of 15, 16,
 * or 17 significant digits that reads back as the same double, in printf's
 * `%e` form, gives the digits and the exponent; `!` keeps printf from stopping
 * at 16 digits and drops trailing zeros. SQLite has no NaN.
 */
function floatToString(value: string): string {
  const e = (n: number): string => `printf('%!.${n}e', abs(f))`;
  const scientific =
    `CASE WHEN CAST(${e(14)} AS REAL) = abs(f) THEN ${e(14)} ` +
    `WHEN CAST(${e(15)} AS REAL) = abs(f) THEN ${e(15)} ELSE ${e(16)} END`;
  return (
    `(SELECT CASE WHEN f IS NULL THEN NULL ` +
    `WHEN abs(f) > 1.7976931348623157e308 THEN (CASE WHEN f > 0 THEN 'Infinity' ELSE '-Infinity' END) ` +
    `ELSE ${javaFloatText('sign', 'digits', 'exponent')} END ` +
    `FROM (SELECT f, CASE WHEN substr(printf('%e', f), 1, 1) = '-' THEN '-' ELSE '' END AS sign, ` +
    `rtrim(replace(substr(x, 1, instr(x, 'e') - 1), '.', ''), '0') AS digits, ` +
    `CAST(substr(x, instr(x, 'e') + 1) AS INTEGER) AS exponent ` +
    `FROM (SELECT f, ${scientific} AS x FROM (SELECT ${value} AS f))))`
  );
}
