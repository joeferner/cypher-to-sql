import {
  ENTITY_TAG,
  entityFields,
  javaFloatText,
  sqlStringLiteral,
  type Dialect,
  type EntityColumns,
  type ScalarType,
} from './dialect.js';

const SQL_TYPES: Record<ScalarType, string> = {
  boolean: 'boolean',
  integer: 'bigint',
  float: 'double precision',
  string: 'text',
};

/**
 * jsonb of a float. to_jsonb(2.0::float8) is the integer 2, so go through
 * numeric and give integral values one decimal place; float8 text is the
 * shortest exact form. NaN and infinity have no JSON form. A subquery computes
 * the value once.
 */
function floatToJsonb(value: string): string {
  return (
    `(SELECT CASE WHEN f IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8) THEN NULL ` +
    `WHEN f::text::numeric = trunc(f::text::numeric) THEN to_jsonb(round(f::text::numeric, 1)) ` +
    `ELSE to_jsonb(f::text::numeric) END FROM (SELECT (${value})::double precision AS f) AS ft)`
  );
}

/**
 * A float as toString() writes it (see `javaFloatText`). float8 text is the
 * shortest exact form; as numeric text it has no exponent, so the digits and
 * the exponent follow from the parts before and after the point.
 */
function floatToString(value: string): string {
  return (
    `(SELECT CASE WHEN f IS NULL THEN NULL WHEN f = 'NaN' THEN 'NaN' ` +
    `WHEN f = 'Infinity' THEN 'Infinity' WHEN f = '-Infinity' THEN '-Infinity' ` +
    `ELSE ${javaFloatText('sign', 'digits', 'exponent')} END FROM (` +
    `SELECT f, sign, ` +
    `CASE WHEN ip <> '0' THEN rtrim(ip || fp, '0') ELSE rtrim(ltrim(fp, '0'), '0') END AS digits, ` +
    `CASE WHEN ip <> '0' THEN length(ip) - 1 ELSE -(length(fp) - length(ltrim(fp, '0')) + 1) END ` +
    `AS exponent FROM (` +
    `SELECT f, CASE WHEN f::text LIKE '-%' THEN '-' ELSE '' END AS sign, ` +
    `split_part(t, '.', 1) AS ip, split_part(t, '.', 2) AS fp FROM (` +
    `SELECT f, CASE WHEN f IN ('NaN', 'Infinity', '-Infinity') THEN '0' ` +
    `ELSE abs(f)::text::numeric::text END AS t ` +
    `FROM (SELECT (${value})::double precision AS f) AS fa) AS fb) AS fc) AS fd)`
  );
}

/**
 * `string =~ pattern` with PostgreSQL's advanced regular expressions (ARE),
 * which share most of Java's syntax. The pattern must match the whole string,
 * so it is wrapped in `\A(?: ... )\Z`. Java's leading embedded flags `(?imsx)`
 * become ARE's, which must come first: `i` and `x` are the same; without `s`,
 * Java's `.` does not match a newline (ARE `p`), and `m` makes `^` and `$`
 * match at lines (ARE `n`, or `w` with `s`). Other Java syntax that ARE lacks
 * (flags inside the pattern, possessive quantifiers, `\Q...\E`) is an invalid
 * regular expression.
 */
function regexMatch(string: string, pattern: string): string {
  const has = (flag: string): string => `position('${flag}' in f) > 0`;
  const flags =
    `(CASE WHEN ${has('i')} THEN 'i' ELSE '' END) || (CASE WHEN ${has('x')} THEN 'x' ELSE '' END) || ` +
    `(CASE WHEN ${has('m')} THEN (CASE WHEN ${has('s')} THEN 'w' ELSE 'n' END) ` +
    `ELSE (CASE WHEN ${has('s')} THEN 's' ELSE 'p' END) END)`;
  const leading = `'^\\(\\?[a-zA-Z]*\\)'`;
  const body = `(CASE WHEN p ~ ${leading} THEN substr(p, length(f) + 4) ELSE p END)`;
  return (
    `(SELECT CASE WHEN s IS NULL OR p IS NULL THEN NULL ` +
    `ELSE s ~ ('(?' || ${flags} || ')\\A(?:' || ${body} || ')\\Z') END ` +
    `FROM (SELECT s, p, coalesce(substring(p from '^\\(\\?([a-zA-Z]*)\\)'), '') AS f ` +
    `FROM (SELECT (${string})::text AS s, (${pattern})::text AS p) AS ra) AS rb)`
  );
}

/** An entity's tagged object: its properties with the reserved keys added. */
function entityObject(kind: 'node' | 'relationship', alias: string, table: EntityColumns): string {
  const fields = entityFields(kind, alias, table, (c) => c);
  return (
    `(${alias}.${table.properties} || jsonb_build_object(` +
    `${fields.map(([k, v]) => `${k}::text, ${v}`).join(', ')}))`
  );
}

/**
 * PostgreSQL dialect. JSON columns are `jsonb`. Works on managed PostgreSQL
 * (RDS, Aurora, and others) because it needs no extensions.
 */
/**
 * A JSON id (number or string) as a value of the type of the id column `id` of
 * `table`, which the planner does not know: a record of the table's row type
 * gets the column from the JSON, through the column type's input function.
 * Mapping names are plain identifiers (validateMapping), so `id` is safe as a
 * string literal.
 */
function typedId(json: string, table: string, id: string): string {
  return `(jsonb_populate_record(NULL::${table}, jsonb_build_object('${id}', ${json})))."${id}"`;
}

export function postgres(): Dialect {
  return {
    name: 'postgres',
    quoteIdent: (name) => `"${name}"`,
    placeholder: (index) => `$${index}`,
    numberedPlaceholders: true,
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
      `WHEN 'array' THEN 'list' WHEN 'object' THEN COALESCE((${json}) ->> '${ENTITY_TAG}', 'map') ` +
      `WHEN 'null' THEN 'null' END)`,
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
        case 'integer':
          // Also guarded by range: a constant float such as 1e21 must not fail the cast.
          return (
            `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN CASE WHEN (${json})::numeric ` +
            `BETWEEN -9223372036854775808 AND 9223372036854775807 THEN ${json} END END)::bigint`
          );
        default:
          return `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN ${json} END)::${SQL_TYPES[type]}`;
      }
    },
    toJson: (value, type) => (type === 'float' ? floatToJsonb(value) : `to_jsonb(${value})`),
    floatToString,
    changeCase: (string, to) => `${to}(${string})`,
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
    regexMatch,
    power: (base, exponent) =>
      `power((${base})::double precision, (${exponent})::double precision)`,
    jsonAggregate: (value, { distinct, orderBy, filter }) =>
      `COALESCE(jsonb_agg(${distinct ? 'DISTINCT ' : ''}${value}` +
      `${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''}) FILTER (WHERE ${filter}), '[]'::jsonb)`,
    // min() and max() are not defined for booleans.
    booleanAggregate: (kind, value) => `${kind === 'min' ? 'bool_and' : 'bool_or'}(${value})`,
    stringAggregate: (value, orderBy) =>
      `string_agg(${value}, ''${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''})`,
    // Sign class, a biased decimal exponent, and the mantissa in [1, 10) (for
    // negative numbers both complemented, so that larger magnitudes sort first).
    // log() of zero, infinity, or NaN is an error or useless, so those take
    // log(1). The exponent stops at -300, so that power(10, e) never underflows
    // to zero; below that the mantissa is less than 1, still in order.
    sortableNumber: (value) =>
      `(SELECT CASE WHEN f = 'NaN'::float8 THEN 'P' WHEN f = 0 THEN 'M' ` +
      `WHEN f = 'Infinity'::float8 THEN 'O' WHEN f = '-Infinity'::float8 THEN 'K' ` +
      `WHEN f > 0 THEN 'N' || to_char(e + 400, 'FM000') || to_char(abs(f) / power(10::float8, e), 'FM0.000000000000000') ` +
      `ELSE 'L' || to_char(599 - e, 'FM000') || to_char(10 - abs(f) / power(10::float8, e), 'FM0.000000000000000') END ` +
      `FROM (SELECT f, GREATEST(CASE WHEN abs(f) / power(10::float8, e0) >= 10 THEN e0 + 1 ` +
      `WHEN abs(f) / power(10::float8, e0) < 1 THEN e0 - 1 ELSE e0 END, -300) AS e ` +
      `FROM (SELECT f, GREATEST(floor(log(CASE WHEN f = 0 OR f IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8) ` +
      `THEN 1 ELSE abs(f) END))::int, -300) AS e0 ` +
      `FROM (SELECT (${value})::float8 AS f) AS x) AS y) AS z)`,
    // chr(1) is escaped as chr(1) || chr(2) and the terminator is chr(1) || chr(1).
    sortableString: (string) =>
      `(replace(${string}, chr(1), chr(1) || chr(2)) || chr(1) || chr(1))`,
    // Set-returning JSON functions fail on the wrong type, so their inputs are
    // guarded (see fromJson).
    jsonRemoveKeys: (map, keys) => `(${map} - ARRAY[${keys.map(sqlStringLiteral).join(', ')}])`,
    jsonKeys: (map) =>
      `(SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb) FROM jsonb_object_keys(` +
      `CASE WHEN jsonb_typeof(${map}) = 'object' THEN ${map} END) AS k)`,
    // `->` with a text key gives NULL for a non-object.
    jsonMemberAt: (object, key) => `(${object} -> (${key})::text)`,
    jsonElement: (list, index) => `(${list} -> (${index})::int)`,
    jsonTail: (list) => `(CASE WHEN jsonb_typeof(${list}) = 'array' THEN ${list} - 0 END)`,
    reverseList: (list) =>
      `(SELECT COALESCE(jsonb_agg(e.value ORDER BY e.i DESC), '[]'::jsonb) FROM jsonb_array_elements(` +
      `CASE WHEN jsonb_typeof(${list}) = 'array' THEN ${list} END) WITH ORDINALITY AS e(value, i))`,
    reverseString: (string) => `reverse(${string})`,
    range: (start, end, step) =>
      `(SELECT COALESCE(jsonb_agg(g.v ORDER BY g.i), '[]'::jsonb) FROM generate_series(` +
      `(${start})::bigint, (${end})::bigint, (${step})::bigint) WITH ORDINALITY AS g(v, i))`,
    // string_to_array('', ',') is empty, but split('', ',') is [''].
    split: (string, delimiter) =>
      `(CASE WHEN ${string} = '' THEN '[""]'::jsonb ELSE to_jsonb(string_to_array(${string}, ${delimiter})) END)`,
    stringLength: (string) => `char_length(${string})`,
    substring: (string, start, length) =>
      `substr(${string}, (${start})::int + 1${length === undefined ? '' : `, (${length})::int`})`,
    rightString: (string, count) => `right(${string}, (${count})::int)`,
    // Casts are guarded so that they never fail (see fromJson).
    parseNumber: (string, type): string => {
      const int = `'^\\s*[+-]?[0-9]+\\s*$'`;
      const num = `'^\\s*[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'`;
      const float = `(CASE WHEN ${string} ~ ${num} THEN trim(${string}) END)::double precision`;
      return type === 'float'
        ? float
        : `COALESCE((CASE WHEN ${string} ~ ${int} THEN trim(${string}) END)::bigint, trunc(${float})::bigint)`;
    },
    toFloat: (number) => `(${number})::double precision`,
    truncate: (float) => `trunc(${float})::bigint`,
    math: (name, args): string => {
      const f = args.map((a) => `(${a})::double precision`);
      switch (name) {
        case 'log':
          return `ln(${f[0]})`;
        case 'log10':
          return `log(${f[0]})`;
        case 'e':
          return 'exp(1::double precision)';
        case 'pi':
          return 'pi()';
        case 'rand':
          return 'random()';
        default:
          return `${name}(${f.join(', ')})`;
      }
    },
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
    entityJson: entityObject,
    // The id column's type is not known here, so compare as text.
    jsonIdEquals: (column, json) => `((${column})::text = (${json} #>> '{}'))`,
    pathJson: (nodes, relationships) =>
      `jsonb_build_object('${ENTITY_TAG}'::text, 'path'::text, '~nodes'::text, ${nodes}, ` +
      `'~relationships'::text, ${relationships})`,
    entityList: (kind, list, table) =>
      `(CASE WHEN ${list} IS NULL THEN NULL ELSE COALESCE((SELECT jsonb_agg(` +
      `${entityObject(kind, 've', table)} ORDER BY vu.i) FROM unnest(${list}) WITH ORDINALITY AS vu(id, i) ` +
      `JOIN ${table.table} AS ve ON ve.${table.id} = vu.id), '[]'::jsonb) END)`,
    // Arrays of the id column's type. The empty array gets that type from an
    // aggregate over no rows, so the planner needs no knowledge of column types.
    idListEmpty: (table, id) =>
      `COALESCE((SELECT array_agg(ve.${id}) FROM ${table} AS ve WHERE FALSE), '{}')`,
    idListAppend: (list, id) => `(${list} || ${id})`,
    idListHas: (list, id) => `(${id} = ANY(${list}))`,
    idListsOverlap: (left, right) => `(${left} && ${right})`,
    idListLength: (list) => `cardinality(${list})::bigint`,
    // PostgreSQL estimates selectivity from statistics; it takes no hints.
    selective: (condition) => condition,
    // A failed cast to integer quotes the text. random() keeps PostgreSQL from
    // folding the cast at plan time, which it does to constants even in CASE
    // branches that never run.
    raise: (marker, type): string => {
      const failed = `(('${marker}' || CASE WHEN random() >= 0 THEN '' END)::int)`;
      switch (type) {
        case 'json':
          return `to_jsonb(${failed})`;
        case 'boolean':
          return `(${failed} = 0)`;
        case 'string':
          return `(${failed})::text`;
        default:
          return `(${failed})::${SQL_TYPES[type]}`;
      }
    },
    // bigint arithmetic raises its own error on overflow (mapped by the plan runner).
    checkedInteger: (expr) => expr,
    jsonId: (json, table, id) => typedId(json, table, id),
    // = ANY(ARRAY(...)) runs the subquery once and lets the column's index be used.
    boundIdIn: (column, json, table, id) =>
      `${column} = ANY(ARRAY(SELECT ${typedId('x.value', table, id)} ` +
      `FROM jsonb_array_elements(${json}) AS x))`,
    boundPaths: (json, nodes, edges): string => {
      const list = (key: string, t: { table: string; id: string }): string =>
        `ARRAY(SELECT ${typedId('x.value', t.table, t.id)} FROM jsonb_array_elements(j.value -> '${key}') ` +
        `WITH ORDINALITY AS x(value, i) ORDER BY x.i)`;
      return (
        `SELECT ${typedId(`j.value -> 's'`, nodes.table, nodes.id)} AS s, ` +
        `${typedId(`j.value -> 't'`, nodes.table, nodes.id)} AS t, ` +
        `${list('r', edges)} AS path, ${list('n', nodes)} AS nodes FROM jsonb_array_elements(${json}) AS j`
      );
    },
    noFlatten: ' OFFSET 0',
    limitAll: 'ALL',
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
      index: `(${alias}.ord - 1)`,
    }),
  };
}
