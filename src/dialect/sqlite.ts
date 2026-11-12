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
    // Not LIKE: it is case-insensitive for ASCII and treats % and _ as wildcards.
    startsWith: (string, prefix) => `(substr(${string}, 1, length(${prefix})) = ${prefix})`,
    endsWith: (string, suffix) =>
      `(CASE WHEN ${string} IS NULL OR ${suffix} IS NULL THEN NULL ` +
      `WHEN length(${suffix}) = 0 THEN 1 ELSE substr(${string}, -length(${suffix})) = ${suffix} END)`,
    contains: (string, part) => `(instr(${string}, ${part}) > 0)`,
    power: (base, exponent) => `pow(${base}, ${exponent})`,
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
