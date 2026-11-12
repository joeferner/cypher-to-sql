import { UnsupportedFeatureError } from '../errors.js';
import { sqlStringLiteral, type Dialect, type ScalarType } from './dialect.js';

/**
 * SQLite dialect. Requires SQLite 3.38 or newer for the `->` JSON operator, and
 * the math functions (`pow`, `trunc`; on by default in most builds) for `^` and
 * float `%`. JSON values are JSON text; booleans are the integers 1 and 0.
 */
export function sqlite(): Dialect {
  return {
    name: 'sqlite',
    quoteIdent: (name) => `"${name}"`,
    placeholder: () => '?',
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
    typedPlaceholder: (placeholder, type) =>
      type === 'float' ? `CAST(${placeholder} AS REAL)` : placeholder,
    booleanLiteral: (value) => (value === null ? 'NULL' : value ? '1' : '0'),
    jsonType: (json) =>
      `(CASE json_type(${json}) WHEN 'integer' THEN 'integer' WHEN 'real' THEN 'float' ` +
      `WHEN 'text' THEN 'string' WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean' ` +
      `WHEN 'array' THEN 'list' WHEN 'object' THEN 'map' WHEN 'null' THEN 'null' END)`,
    jsonIsNull: (json) => `(COALESCE(json_type(${json}), 'null') = 'null')`,
    fromJson: (json) => `(${json} ->> '$')`,
    toJson,
    // json() marks JSON text as JSON, so that it is nested rather than quoted.
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
    power: (base, exponent) => `pow(${base}, ${exponent})`,
    jsonKeys: (map) =>
      `(SELECT json_group_array(key) FROM (SELECT key FROM json_each(${map}) ORDER BY key))`,
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
    // SQLite does not flatten a subquery that has an OFFSET.
    noFlatten: ' LIMIT -1 OFFSET 0',
    // 9e999 is infinity in SQLite. NaN becomes NULL in SQLite.
    floatDivide: (dividend, divisor) =>
      `(CASE WHEN ${divisor} = 0 THEN CASE WHEN ${dividend} > 0 THEN 9e999 ` +
      `WHEN ${dividend} < 0 THEN -9e999 END ELSE ${dividend} * 1.0 / ${divisor} END)`,
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
  const digits = (n: number): string => `printf('%.${n}g', f)`;
  const shortest =
    `CASE WHEN CAST(${digits(15)} AS REAL) = f THEN ${digits(15)} ` +
    `WHEN CAST(${digits(16)} AS REAL) = f THEN ${digits(16)} ELSE ${digits(17)} END`;
  return (
    `(SELECT CASE WHEN s IS NULL THEN NULL WHEN s GLOB '*[^0-9-]*' THEN s ELSE s || '.0' END ` +
    `FROM (SELECT CASE WHEN f IS NULL OR abs(f) > 1.7976931348623157e308 THEN NULL ` +
    `ELSE ${shortest} END AS s FROM (SELECT ${value} AS f)))`
  );
}
