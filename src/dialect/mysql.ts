import {
  ENTITY_TAG,
  entityFields,
  javaFloatText,
  sqlStringLiteral,
  type Dialect,
  type EntityColumns,
  type ScalarType,
} from './dialect.js';

// MySQL 8.0.17 or newer (JSON_TABLE, LATERAL, recursive CTEs, JSON_OVERLAPS,
// CAST AS DOUBLE). The executor must set, on each connection:
//
//   SET SESSION sql_mode = CONCAT(REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''), ',PIPES_AS_CONCAT'),
//       NAMES utf8mb4 COLLATE utf8mb4_bin,
//       SESSION group_concat_max_len = 1073741824,
//       SESSION cte_max_recursion_depth = 4294967295
//
// `||` then concatenates strings, MySQL accepts the grouped queries the
// planner writes (a node's properties next to its grouped id, also through a
// derived table, which ONLY_FULL_GROUP_BY does not see), strings are
// case-sensitive (comparisons also add utf8mb4_0900_bin, see `exact`, which
// does not ignore trailing spaces), ordered JSON lists (built with GROUP_CONCAT) are
// not cut short, and range() and split() can go past 1000 elements. See
// examples/executors/mysql2.ts. An INSERT returns no rows in MySQL, so the
// executor returns `[{ id: insertId }]` for it.
//
// JSON values are of MySQL's JSON type. MySQL has no NaN or infinity: a float
// division by zero, or a result out of range, is NULL (as NaN is on SQLite).

/** `CAST(x AS JSON)`: parses JSON text, keeps JSON as it is. */
const asJson = (value: string): string => `CAST(${value} AS JSON)`;

/** JSON null. */
const JSON_NULL = `CAST('null' AS JSON)`;

/**
 * A string as compared in Cypher: by code point, trailing spaces included.
 * The session's utf8mb4_bin is PAD SPACE (`'a' = 'a '` is true there), so
 * comparisons use utf8mb4_0900_bin, which is NO PAD. CONVERT makes it safe for
 * NULL, whose character set is binary.
 */
const exact = (string: string): string =>
  `(CONVERT(${string} USING utf8mb4) COLLATE utf8mb4_0900_bin)`;

/** A JSON path to the member named by the SQL string `key`, quoted and escaped. */
const memberPath = (key: string): string =>
  `CONCAT('$."', REPLACE(REPLACE(${key}, '\\\\', '\\\\\\\\'), '"', '\\\\"'), '"')`;

/** A JSON path to the member `key`, from the mapping or the library (no `"` or `\`). */
const literalPath = (key: string): string => sqlStringLiteral(`$."${key}"`);

/**
 * Aggregate: a JSON list of the JSON values `value` of the group's rows (SQL
 * NULLs skipped), in `orderBy` order. JSON_ARRAYAGG takes no ORDER BY, so the
 * list is assembled from the values' JSON text.
 */
function aggregate(value: string, orderBy: string[] = [], distinct = false): string {
  const order = orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : '';
  return (
    `CAST(CONCAT('[', COALESCE(GROUP_CONCAT(${distinct ? 'DISTINCT ' : ''}` +
    `CAST(${asJson(value)} AS CHAR)${order} SEPARATOR ','), ''), ']') AS JSON)`
  );
}

/**
 * FROM items: the JSON value `value` computed once as `<alias>l.j` (with its
 * JSON_TYPE as `<alias>l.t`), then JSON_TABLE over it as `alias`. JSON_TABLE
 * fails ("Incorrect arguments", "Unknown column") on a subquery, or on a column
 * of a derived table merged into the query; a LATERAL derived table with a
 * LIMIT is neither merged nor a subquery argument.
 */
const jsonTable = (value: string, alias: string, columns: string): string =>
  `LATERAL (SELECT ${asJson(value)} AS j, JSON_TYPE(${asJson(value)}) AS t LIMIT 1) AS ${alias}l ` +
  `JOIN JSON_TABLE(${alias}l.j, '$[*]' COLUMNS (${columns})) AS ${alias} ON TRUE`;

/** The elements of a JSON list as rows `alias(i, v)`: 1-based position, JSON value. */
const elements = (list: string, alias: string): string =>
  jsonTable(list, alias, `i FOR ORDINALITY, v JSON PATH '$'`);

/** The JSON value of an element row (JSON_TABLE gives SQL NULL for a JSON null). */
const element = (alias: string): string => `COALESCE(${alias}.v, ${JSON_NULL})`;

/** An entity's tagged object: its properties with the reserved keys added. */
function entityObject(kind: 'node' | 'relationship', alias: string, table: EntityColumns): string {
  const fields = entityFields(kind, alias, table, (c) => c);
  return `JSON_MERGE_PATCH(${alias}.${table.properties}, JSON_OBJECT(${fields.flat().join(', ')}))`;
}

function toJson(value: string, type: ScalarType): string {
  switch (type) {
    case 'boolean':
      // A boolean from a derived table is an integer to CAST(... AS JSON).
      return `(CASE WHEN ${value} THEN CAST('true' AS JSON) WHEN NOT ${value} THEN CAST('false' AS JSON) END)`;
    case 'string':
      return `JSON_EXTRACT(JSON_ARRAY(${value}), '$[0]')`;
    case 'integer':
      return asJson(value);
    case 'float':
      // A DOUBLE keeps a fraction in JSON (`2.0`).
      return asJson(`CAST(${value} AS DOUBLE)`);
  }
}

/**
 * A DOUBLE as toString() writes it (see `javaFloatText`). MySQL writes the
 * shortest digits that read back as the same double, as a decimal
 * (`123.45`, `0.00000015`) or with an exponent (`1e20`); the digits and the
 * exponent follow from either.
 */
function floatToString(value: string): string {
  return (
    `(SELECT CASE WHEN f IS NULL THEN NULL ELSE ${javaFloatText('sign', 'digits', 'exponent')} END ` +
    `FROM (SELECT f, sign, ` +
    `CASE WHEN ip <> '0' THEN TRIM(TRAILING '0' FROM CONCAT(ip, fp)) ` +
    `ELSE TRIM(TRAILING '0' FROM TRIM(LEADING '0' FROM fp)) END AS digits, ` +
    `ex + CASE WHEN ip <> '0' THEN CHAR_LENGTH(ip) - 1 ` +
    `ELSE -(CHAR_LENGTH(fp) - CHAR_LENGTH(TRIM(LEADING '0' FROM fp)) + 1) END AS exponent ` +
    `FROM (SELECT f, sign, SUBSTRING_INDEX(m, '.', 1) AS ip, ` +
    `CASE WHEN LOCATE('.', m) > 0 THEN SUBSTRING_INDEX(m, '.', -1) ELSE '' END AS fp, ex ` +
    `FROM (SELECT f, CASE WHEN f < 0 THEN '-' ELSE '' END AS sign, SUBSTRING_INDEX(s, 'e', 1) AS m, ` +
    `CASE WHEN LOCATE('e', s) > 0 THEN CAST(SUBSTRING_INDEX(s, 'e', -1) AS SIGNED) ELSE 0 END AS ex ` +
    `FROM (SELECT f, CAST(ABS(f) AS CHAR) AS s FROM (SELECT CAST(${value} AS DOUBLE) AS f) AS fa) AS fb) AS fc) AS fd) AS fe)`
  );
}

/** Cypher's class of a JSON value for `=`: numbers of either type compare by value. */
const valueClass = (json: string): string =>
  `CASE JSON_TYPE(${json}) WHEN 'INTEGER' THEN 'number' WHEN 'UNSIGNED INTEGER' THEN 'number' ` +
  `WHEN 'DOUBLE' THEN 'number' WHEN 'DECIMAL' THEN 'number' ELSE JSON_TYPE(${json}) END`;

export function mysql(): Dialect {
  return {
    name: 'mysql',
    quoteIdent: (name) => `\`${name}\``,
    placeholder: () => '?',
    numberedPlaceholders: false,
    returning: false,
    nullsOrder: false,
    limitExpressions: false,
    jsonInput: (placeholder) => asJson(placeholder),
    jsonText: (expr) => `CAST(${expr} AS CHAR)`,
    // The key is a bind value, quoted into the path at run time as data.
    jsonMember: (objectExpr, keyPlaceholder) =>
      `JSON_EXTRACT(${objectExpr}, ${memberPath(keyPlaceholder)})`,
    // A functional index on the same expression serves these (see examples/schema/mysql.sql).
    typedMember: (objectExpr, key, type): string => {
      const member = `JSON_EXTRACT(${objectExpr}, ${literalPath(key)})`;
      switch (type) {
        case 'string':
          // MySQL does not use a functional index for a string read like this
          // (it does for the integer form below).
          return `JSON_UNQUOTE(${member})`;
        case 'integer':
          return `CAST(${member} AS SIGNED)`;
        case 'float':
          return `CAST(${member} AS DOUBLE)`;
        case 'boolean':
          return `(${member} = CAST('true' AS JSON))`;
      }
    },
    hasLabel: (labelsExpr, labelPlaceholder) =>
      `JSON_CONTAINS(${labelsExpr}, JSON_QUOTE(${labelPlaceholder}))`,
    mergeProperties: (properties, patch) => `JSON_MERGE_PATCH(${properties}, ${patch})`,
    appendLabel: (labels, label) => `JSON_ARRAY_APPEND(${labels}, '$', ${label})`,
    removeLabel: (labels, label) =>
      `(SELECT ${aggregate(element('rl'), ['rl.i'])} FROM ${elements(labels, 'rl')} ` +
      `WHERE ${exact(`JSON_UNQUOTE(${element('rl')})`)} <> ${exact(label)})`,
    typedPlaceholder: (placeholder, type) =>
      type === 'integer'
        ? `CAST(${placeholder} AS SIGNED)`
        : type === 'float'
          ? `CAST(${placeholder} AS DOUBLE)`
          : placeholder,
    booleanLiteral: (value) => (value === null ? 'NULL' : value ? 'TRUE' : 'FALSE'),
    // MySQL calls some integers that fit in 64 signed bits UNSIGNED INTEGER (2^63 - 1
    // is one); beyond 64 signed bits a number is a float in Cypher.
    jsonType: (json) =>
      `(CASE JSON_TYPE(${json}) WHEN 'INTEGER' THEN 'integer' WHEN 'UNSIGNED INTEGER' THEN ` +
      `CASE WHEN CAST(${json} AS DECIMAL(20, 0)) <= 9223372036854775807 THEN 'integer' ELSE 'float' END ` +
      `WHEN 'DOUBLE' THEN 'float' WHEN 'DECIMAL' THEN 'float' WHEN 'STRING' THEN 'string' ` +
      `WHEN 'BOOLEAN' THEN 'boolean' WHEN 'ARRAY' THEN 'list' ` +
      `WHEN 'OBJECT' THEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${json}, '$."${ENTITY_TAG}"')), 'map') ` +
      `WHEN 'NULL' THEN 'null' END)`,
    jsonIsNull: (json) => `(COALESCE(JSON_TYPE(${json}), 'NULL') = 'NULL')`,
    fromJson: (json, type): string => {
      switch (type) {
        case 'string':
          return `JSON_UNQUOTE(${json})`;
        case 'boolean':
          return `(${json} = CAST('true' AS JSON))`;
        case 'integer':
          return `CAST(${json} AS SIGNED)`;
        case 'float':
        case 'number':
          return `CAST(${json} AS DOUBLE)`;
      }
    },
    toJson,
    floatToString,
    changeCase: (string, to) => `${to.toUpperCase()}(${string})`,
    jsonSetKey: (object, keyPlaceholder, _key, value) =>
      `JSON_SET(${object}, ${memberPath(keyPlaceholder)}, ${asJson(value)})`,
    jsonArray: (items) => `JSON_ARRAY(${items.map(asJson).join(', ')})`,
    jsonObject: (entries) =>
      `JSON_OBJECT(${entries.map((e) => `${e.keyPlaceholder}, ${asJson(e.value)}`).join(', ')})`,
    listLength: (json) => `JSON_LENGTH(${json})`,
    compareStrings: (left, operator, right) => `(${exact(left)} ${operator} ${exact(right)})`,
    orderString: (string) => exact(string),
    startsWith: (string, prefix) =>
      `(${exact(`LEFT(${string}, CHAR_LENGTH(${prefix}))`)} = ${exact(prefix)})`,
    endsWith: (string, suffix) =>
      `(${exact(`RIGHT(${string}, CHAR_LENGTH(${suffix}))`)} = ${exact(suffix)})`,
    contains: (string, part) => `(LOCATE(${exact(part)}, ${exact(string)}) > 0)`,
    // MySQL's regular expressions are ICU's, close to Java's; `c` is case-sensitive.
    regexMatch: (string, pattern) =>
      `REGEXP_LIKE(${string}, CONCAT('\\\\A(?:', ${pattern}, ')\\\\z'), 'c')`,
    temporalCall: undefined,
    temporalArithmetic: undefined,
    power: (base, exponent) => `POW(${base}, ${exponent})`,
    // A row that passes the filter with an SQL NULL value is a JSON null in the
    // list; GROUP_CONCAT would skip it.
    jsonAggregate: (value, { distinct, orderBy, filter }) =>
      aggregate(
        `CASE WHEN ${filter} THEN COALESCE(${asJson(value)}, ${JSON_NULL}) END`,
        orderBy,
        distinct,
      ),
    booleanAggregate: (kind, value) => `${kind.toUpperCase()}(${value})`,
    stringAggregate: (value, orderBy) =>
      `GROUP_CONCAT(${value}${orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''} SEPARATOR '')`,
    // Sign class, a biased decimal exponent, and the mantissa in [1, 10) (for
    // negative numbers both complemented, so that larger magnitudes sort first).
    sortableNumber: (value) =>
      `(SELECT CASE WHEN f = 0 THEN 'M' ` +
      `WHEN f > 0 THEN CONCAT('N', LPAD(e + 400, 3, '0'), FORMAT(ABS(f) / POW(10, e), 15)) ` +
      `ELSE CONCAT('L', LPAD(599 - e, 3, '0'), FORMAT(10 - ABS(f) / POW(10, e), 15)) END ` +
      `FROM (SELECT f, GREATEST(CASE WHEN ABS(f) / POW(10, e0) >= 10 THEN e0 + 1 ` +
      `WHEN ABS(f) / POW(10, e0) < 1 THEN e0 - 1 ELSE e0 END, -300) AS e ` +
      `FROM (SELECT f, GREATEST(CAST(FLOOR(LOG10(CASE WHEN f = 0 THEN 1 ELSE ABS(f) END)) AS SIGNED), -300) AS e0 ` +
      `FROM (SELECT CAST(${value} AS DOUBLE) AS f) AS x) AS y) AS z)`,
    sortableString: (string) =>
      `CONCAT(REPLACE(${string}, CHAR(1 USING utf8mb4), CHAR(1, 2 USING utf8mb4)), CHAR(1, 1 USING utf8mb4))`,
    jsonRemoveKeys: (map, keys) => `JSON_REMOVE(${map}, ${keys.map(literalPath).join(', ')})`,
    jsonKeys: (map) =>
      `(SELECT ${aggregate('JSON_QUOTE(jk.k)', ['jk.k'])} FROM ` +
      `${jsonTable(`JSON_KEYS(${map})`, 'jk', `k VARCHAR(1024) COLLATE utf8mb4_0900_bin PATH '$'`)})`,
    jsonMemberAt: (object, key) =>
      `(CASE WHEN JSON_TYPE(${object}) = 'OBJECT' THEN JSON_EXTRACT(${object}, ${memberPath(key)}) END)`,
    jsonElement: (list, index) =>
      `JSON_EXTRACT(${list}, CASE WHEN ${index} = -1 THEN '$[last]' WHEN ${index} < 0 ` +
      `THEN CONCAT('$[last', ${index} + 1, ']') ELSE CONCAT('$[', ${index}, ']') END)`,
    jsonTail: (list) => `JSON_REMOVE(${list}, '$[0]')`,
    reverseList: (list) =>
      `(SELECT ${aggregate(element('rv'), ['rv.i DESC'])} FROM ${elements(list, 'rv')})`,
    reverseString: (string) => `REVERSE(${string})`,
    range: (start, end, step) =>
      `(WITH RECURSIVE rg(v) AS (SELECT CAST(${start} AS SIGNED) UNION ALL SELECT v + ${step} FROM rg ` +
      `WHERE (${step} > 0 AND v + ${step} <= ${end}) OR (${step} < 0 AND v + ${step} >= ${end})) ` +
      `SELECT ${aggregate('rg.v', ['rg.v * SIGN(' + step + ')'])} FROM rg ` +
      `WHERE (${step} > 0 AND v <= ${end}) OR (${step} < 0 AND v >= ${end}))`,
    // Positions of the delimiter, by a recursive CTE over integers (string
    // columns of a recursive CTE would be cut to the anchor's length). An empty
    // delimiter does not split.
    split: (string, delimiter) =>
      `(WITH RECURSIVE sp(i, st, nx) AS (SELECT 0, 1, ` +
      `CASE WHEN CHAR_LENGTH(${delimiter}) = 0 THEN 0 ELSE LOCATE(${delimiter}, ${string}, 1) END ` +
      `UNION ALL SELECT i + 1, nx + CHAR_LENGTH(${delimiter}), ` +
      `LOCATE(${delimiter}, ${string}, nx + CHAR_LENGTH(${delimiter})) FROM sp WHERE nx > 0) ` +
      `SELECT ${aggregate(
        `JSON_QUOTE(SUBSTRING(${string}, st, CASE WHEN nx = 0 THEN CHAR_LENGTH(${string}) + 1 ELSE nx END - st))`,
        ['sp.i'],
      )} FROM sp)`,
    stringLength: (string) => `CHAR_LENGTH(${string})`,
    substring: (string, start, length) =>
      `SUBSTRING(${string}, ${start} + 1${length === undefined ? '' : `, ${length}`})`,
    rightString: (string, count) => `RIGHT(${string}, ${count})`,
    parseNumber: (string, type): string => {
      const t = `TRIM(${string})`;
      const int = `REGEXP_LIKE(${t}, '^[+-]?[0-9]+$')`;
      const num = `REGEXP_LIKE(${t}, '^[+-]?([0-9]+\\\\.?[0-9]*|\\\\.[0-9]+)([eE][+-]?[0-9]+)?$')`;
      const float = `(CASE WHEN ${num} THEN CAST(${t} AS DOUBLE) END)`;
      return type === 'float'
        ? float
        : `(CASE WHEN ${int} THEN CAST(${t} AS SIGNED) ELSE CAST(TRUNCATE(${float}, 0) AS SIGNED) END)`;
    },
    toFloat: (number) => `CAST(${number} AS DOUBLE)`,
    truncate: (float) => `CAST(TRUNCATE(${float}, 0) AS SIGNED)`,
    math: (name, args): string => {
      const f = args.map((a) => `CAST(${a} AS DOUBLE)`);
      switch (name) {
        case 'log':
          return `LN(${f[0]})`;
        case 'log10':
          return `LOG10(${f[0]})`;
        case 'e':
          return 'EXP(1)';
        case 'pi':
          return 'PI()';
        case 'rand':
          return 'RAND()';
        case 'floor':
        case 'ceil':
          return `CAST(${name.toUpperCase()}(${f[0]}) AS DOUBLE)`;
        default:
          return `${name.toUpperCase()}(${f.join(', ')})`;
      }
    },
    // No infinity or NaN: dividing by zero is NULL.
    floatDivide: (dividend, divisor) =>
      `(CASE WHEN ${divisor} = 0 THEN NULL ELSE CAST(${dividend} AS DOUBLE) / ${divisor} END)`,
    isNaN: undefined,
    integerText: (integer) => `CAST(${integer} AS CHAR)`,
    integerDivide: (dividend, divisor) => `(${dividend} DIV ${divisor})`,
    floatRemainder: (dividend, divisor) => `MOD(${dividend}, ${divisor})`,
    // JSON_MERGE_PRESERVE concatenates two arrays.
    concatLists: (left, right) => `JSON_MERGE_PRESERVE(${left}, ${right})`,
    // Walks both values in parallel with a recursive CTE: one row per pair of
    // values at the same position, then a three-valued AND over the rows.
    jsonDeepEquals: (left, right): string => {
      const both = (type: string, side: 'a' | 'b'): string =>
        `CASE WHEN JSON_TYPE(w.a) = '${type}' AND JSON_TYPE(w.b) = '${type}' THEN w.${side} END`;
      const pair =
        `CASE WHEN COALESCE(JSON_TYPE(a), 'NULL') = 'NULL' OR COALESCE(JSON_TYPE(b), 'NULL') = 'NULL' THEN NULL ` +
        `WHEN ${valueClass('a')} <> ${valueClass('b')} THEN FALSE ` +
        `WHEN JSON_TYPE(a) = 'ARRAY' THEN JSON_LENGTH(a) = JSON_LENGTH(b) ` +
        `WHEN JSON_TYPE(a) = 'OBJECT' THEN JSON_KEYS(a) = JSON_KEYS(b) ` +
        // JSON = compares numbers by value.
        `ELSE a = b END`;
      return (
        `(WITH RECURSIVE w(a, b) AS (SELECT ${asJson(left)}, ${asJson(right)} UNION ALL ` +
        `SELECT ${element('x')}, ${element('y')} FROM w ` +
        `JOIN JSON_TABLE(${both('ARRAY', 'a')}, '$[*]' COLUMNS (i FOR ORDINALITY, v JSON PATH '$')) AS x ` +
        `JOIN JSON_TABLE(${both('ARRAY', 'b')}, '$[*]' COLUMNS (i FOR ORDINALITY, v JSON PATH '$')) AS y ON x.i = y.i ` +
        `UNION ALL SELECT JSON_EXTRACT(w.a, ${memberPath('k.k')}), JSON_EXTRACT(w.b, ${memberPath('k.k')}) FROM w ` +
        `JOIN JSON_TABLE(JSON_KEYS(${both('OBJECT', 'a')}), '$[*]' COLUMNS (k VARCHAR(1024) COLLATE utf8mb4_bin PATH '$')) AS k ` +
        `WHERE JSON_KEYS(w.a) = JSON_KEYS(w.b)) ` +
        `SELECT CASE WHEN SUM(r = 0) > 0 THEN FALSE WHEN SUM(r IS NULL) > 0 THEN NULL ELSE TRUE END ` +
        `FROM (SELECT ${pair} AS r FROM w) AS t)`
      );
    },
    entityJson: entityObject,
    jsonIdEquals: (column, json) => `(${column} = CAST(JSON_UNQUOTE(${json}) AS SIGNED))`,
    pathJson: (nodes, relationships) =>
      `JSON_OBJECT('${ENTITY_TAG}', 'path', '~nodes', ${asJson(nodes)}, '~relationships', ${asJson(relationships)})`,
    entityList: (kind, list, table) =>
      `(CASE WHEN ${list} IS NULL THEN NULL ELSE (SELECT ${aggregate(entityObject(kind, 've', table), ['vj.i'])} ` +
      `FROM ${jsonTable(list, 'vj', `i FOR ORDINALITY, id BIGINT PATH '$'`)} ` +
      `JOIN ${table.table} AS ve ON ve.${table.id} = vj.id) END)`,
    // JSON arrays of ids.
    idListEmpty: () => 'JSON_ARRAY()',
    idListAppend: (list, id) => `JSON_ARRAY_APPEND(${list}, '$', ${id})`,
    idListAggregate: (id, order) => aggregate(id, [order]),
    idListHas: (list, id) => `JSON_CONTAINS(${list}, CAST(${id} AS JSON))`,
    idListsOverlap: (left, right) => `JSON_OVERLAPS(${left}, ${right})`,
    idListLength: (list) => `JSON_LENGTH(${list})`,
    selective: (condition) => condition,
    // UUID_TO_BIN() quotes an invalid UUID in its error. RAND() keeps the call
    // from being evaluated once up front.
    raise: (marker, type): string => {
      const failed = `UUID_TO_BIN(CONCAT('${marker}', LEFT(RAND(), 0)))`;
      switch (type) {
        case 'json':
          return `(CASE WHEN ${failed} IS NULL THEN ${JSON_NULL} END)`;
        case 'boolean':
          return `(${failed} IS NULL)`;
        case 'integer':
          return `CAST(${failed} AS SIGNED)`;
        case 'float':
          return `CAST(${failed} AS DOUBLE)`;
        case 'string':
          return `CAST(${failed} AS CHAR)`;
      }
    },
    // BIGINT arithmetic raises its own error on overflow (mapped by the plan runner).
    checkedInteger: (expr) => expr,
    jsonId: (json) => `CAST(JSON_UNQUOTE(${json}) AS SIGNED)`,
    boundIdIn: (column, json) =>
      `${column} IN (SELECT bi.id FROM JSON_TABLE(${json}, '$[*]' COLUMNS (id BIGINT PATH '$')) AS bi)`,
    // The LIMIT keeps MySQL from merging this into the outer query, where a
    // JSON_TABLE over `path` or `nodes` would fail ("Incorrect arguments").
    boundPaths: (json) =>
      `SELECT CAST(JSON_EXTRACT(j.v, '$.s') AS SIGNED) AS s, CAST(JSON_EXTRACT(j.v, '$.t') AS SIGNED) AS t, ` +
      `JSON_EXTRACT(j.v, '$.r') AS path, JSON_EXTRACT(j.v, '$.n') AS nodes ` +
      `FROM JSON_TABLE(${json}, '$[*]' COLUMNS (v JSON PATH '$')) AS j LIMIT 18446744073709551615`,
    // MySQL does not merge a derived table that has a LIMIT.
    noFlatten: ' LIMIT 18446744073709551615',
    limitAll: '18446744073709551615',
    unwind: (listExpr, alias) => ({
      // A value that is not a list is one row; SQL NULL and JSON null give none.
      from: jsonTable(
        `CASE WHEN JSON_TYPE(${listExpr}) = 'ARRAY' THEN ${asJson(listExpr)} ` +
          `ELSE JSON_ARRAY(${asJson(listExpr)}) END`,
        alias,
        `ord FOR ORDINALITY, v JSON PATH '$'`,
      ),
      where: `COALESCE(JSON_TYPE(${listExpr}), 'NULL') <> 'NULL'`,
      value: element(alias),
      order: `${alias}.ord`,
      index: `(${alias}.ord - 1)`,
    }),
  };
}
