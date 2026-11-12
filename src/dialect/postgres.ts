import { sqlStringLiteral, type Dialect, type ScalarType } from './dialect.js';

const SQL_TYPES: Record<ScalarType, string> = {
  boolean: 'boolean',
  integer: 'bigint',
  float: 'double precision',
  string: 'text',
};

/**
 * PostgreSQL dialect. JSON columns are `jsonb`. Works on managed PostgreSQL
 * (RDS, Aurora, and others) because it needs no extensions.
 */
export function postgres(): Dialect {
  return {
    name: 'postgres',
    quoteIdent: (name) => `"${name}"`,
    placeholder: (index) => `$${index}`,
    jsonInput: (placeholder) => `(${placeholder}::jsonb)`,
    // jsonb keeps the scale of numbers, so `1.0` comes back as `1.0` and integers
    // and floats stay distinct.
    jsonText: (expr) => `(${expr})::text`,
    // The key is a bind value, so it never enters the SQL text.
    jsonMember: (objectExpr, keyPlaceholder) => `(${objectExpr} -> ${keyPlaceholder}::text)`,
    // An expression index such as `((properties ->> 'age')::bigint)` matches this.
    typedMember: (objectExpr, key, type): string => {
      const text = `(${objectExpr} ->> ${sqlStringLiteral(key)})`;
      return type === 'string' ? text : `(${text}::${SQL_TYPES[type]})`;
    },
    // `@>` can use a GIN index on the labels column.
    hasLabel: (labelsExpr, labelPlaceholder) =>
      `(${labelsExpr} @> jsonb_build_array(${labelPlaceholder}::text))`,
    typedPlaceholder: (placeholder, type) => `(${placeholder}::${SQL_TYPES[type]})`,
    booleanLiteral: (value) =>
      value === null ? 'CAST(NULL AS boolean)' : value ? 'TRUE' : 'FALSE',
    // jsonb has one number type. A number is an integer when it is written
    // without a fraction or exponent and fits in 64 bits (see parseCypherJson).
    jsonType: (json) =>
      `(CASE jsonb_typeof(${json}) WHEN 'number' THEN CASE WHEN (${json})::text ~ '^-?[0-9]+$' ` +
      `AND (${json})::numeric BETWEEN -9223372036854775808 AND 9223372036854775807 ` +
      `THEN 'integer' ELSE 'float' END WHEN 'string' THEN 'string' WHEN 'boolean' THEN 'boolean' ` +
      `WHEN 'array' THEN 'list' WHEN 'object' THEN 'map' WHEN 'null' THEN 'null' END)`,
    jsonIsNull: (json) => `(COALESCE(jsonb_typeof(${json}), 'null') = 'null')`,
    // The casts are guarded so that they never fail: PostgreSQL may evaluate a
    // CASE branch early when its input is a constant (a bound parameter), even
    // if the branch is not taken.
    fromJson: (json, type): string => {
      switch (type) {
        case 'string':
          return `(${json} #>> '{}')`;
        case 'boolean':
          return `(CASE WHEN jsonb_typeof(${json}) = 'boolean' THEN ${json} END)::boolean`;
        case 'number':
          return `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN ${json} END)::numeric`;
        default:
          return `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN ${json} END)::${SQL_TYPES[type]}`;
      }
    },
    toJson: (value, type) =>
      type === 'float'
        ? // to_jsonb(2.0::float8) is the integer 2, so go through numeric and
          // give integral values one decimal place. float8 text is the shortest
          // exact form. NaN and infinity have no JSON form.
          `(SELECT CASE WHEN f IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8) THEN NULL ` +
          `WHEN f::text::numeric = trunc(f::text::numeric) THEN to_jsonb(round(f::text::numeric, 1)) ` +
          `ELSE to_jsonb(f::text::numeric) END FROM (SELECT (${value})::double precision AS f) AS ft)`
        : `to_jsonb(${value})`,
    jsonArray: (items) => `jsonb_build_array(${items.join(', ')})`,
    jsonObject: (entries) =>
      `jsonb_build_object(${entries.map((e) => `${e.keyPlaceholder}::text, ${e.value}`).join(', ')})`,
    // Guarded like fromJson: jsonb_array_length fails on a scalar.
    listLength: (json) =>
      `jsonb_array_length(CASE WHEN jsonb_typeof(${json}) = 'array' THEN ${json} END)`,
    // The "C" collation compares by code point; the default collation may not.
    compareStrings: (left, operator, right) =>
      operator === '=' || operator === '<>'
        ? `(${left} ${operator} ${right})`
        : `(${left} COLLATE "C" ${operator} ${right} COLLATE "C")`,
    orderString: (string) => `(${string} COLLATE "C")`,
    startsWith: (string, prefix) => `starts_with(${string}, ${prefix})`,
    endsWith: (string, suffix) => `(right(${string}, length(${suffix})) = ${suffix})`,
    contains: (string, part) => `(strpos(${string}, ${part}) > 0)`,
    power: (base, exponent) =>
      `power((${base})::double precision, (${exponent})::double precision)`,
    floatDivide: (dividend, divisor) =>
      `(CASE WHEN ${divisor} = 0 THEN CASE WHEN ${dividend} > 0 THEN 'Infinity'::float8 ` +
      `WHEN ${dividend} < 0 THEN '-Infinity'::float8 ELSE 'NaN'::float8 END ` +
      `ELSE ${dividend} / ${divisor} END)`,
    concatLists: (left, right) => `(${left} || ${right})`,
    // Walks both values in parallel with a recursive CTE: one row per pair of
    // values at the same position, then a three-valued AND over the rows.
    jsonDeepEquals: (left, right): string => {
      const both = (type: string, side: 'a' | 'b'): string =>
        `CASE WHEN jsonb_typeof(w.a) = '${type}' AND jsonb_typeof(w.b) = '${type}' THEN w.${side} END`;
      const pair =
        `CASE WHEN COALESCE(jsonb_typeof(a), 'null') = 'null' OR COALESCE(jsonb_typeof(b), 'null') = 'null' THEN NULL ` +
        `WHEN jsonb_typeof(a) <> jsonb_typeof(b) THEN FALSE ` +
        `WHEN jsonb_typeof(a) = 'array' THEN jsonb_array_length(a) = jsonb_array_length(b) ` +
        `WHEN jsonb_typeof(a) = 'object' THEN ` +
        `ARRAY(SELECT jsonb_object_keys(a) ORDER BY 1) = ARRAY(SELECT jsonb_object_keys(b) ORDER BY 1) ` +
        // jsonb compares numbers by value.
        `ELSE a = b END`;
      return (
        `(WITH RECURSIVE w(a, b) AS (SELECT (${left})::jsonb, (${right})::jsonb UNION ALL ` +
        `SELECT c.a, c.b FROM w, LATERAL (` +
        `SELECT x.value AS a, y.value AS b FROM jsonb_array_elements(${both('array', 'a')}) WITH ORDINALITY AS x(value, i) ` +
        `JOIN jsonb_array_elements(${both('array', 'b')}) WITH ORDINALITY AS y(value, i) ON x.i = y.i ` +
        `UNION ALL SELECT x.value, y.value FROM jsonb_each(${both('object', 'a')}) AS x ` +
        `JOIN jsonb_each(${both('object', 'b')}) AS y ON x.key = y.key) AS c) ` +
        `SELECT CASE WHEN bool_or(r = FALSE) THEN FALSE WHEN bool_or(r IS NULL) THEN NULL ELSE TRUE END ` +
        `FROM (SELECT ${pair} AS r FROM w) AS t)`
      );
    },
    noFlatten: ' OFFSET 0',
    unwind: (listExpr, alias) => ({
      // jsonb_array_elements raises an error for a non-array, so a scalar is a
      // separate branch. SQL NULL and JSON null give no rows.
      from:
        `LATERAL (SELECT e.value, e.ord FROM jsonb_array_elements(` +
        `CASE WHEN jsonb_typeof(${listExpr}) = 'array' THEN ${listExpr} END) ` +
        `WITH ORDINALITY AS e(value, ord) ` +
        `UNION ALL SELECT ${listExpr}, 1 WHERE jsonb_typeof(${listExpr}) NOT IN ('array', 'null')) ` +
        `AS ${alias}`,
      where: undefined,
      value: `${alias}.value`,
      order: `${alias}.ord`,
    }),
  };
}
