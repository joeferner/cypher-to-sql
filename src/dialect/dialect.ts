/** Native SQL types the expression compiler works with. */
export type ScalarType = 'boolean' | 'integer' | 'float' | 'string';

/**
 * SQL differences between databases. The planner builds SQL from these pieces,
 * so it never writes database-specific syntax itself.
 *
 * Every JSON-valued expression the planner selects is returned as JSON *text*
 * (see `jsonText`), and the assembler parses it. That keeps the int/float
 * distinction and works the same way on every driver.
 *
 * Methods may use an argument more than once in the SQL they return. The
 * expression compiler only passes arguments that are cheap to repeat (columns,
 * bind values, or columns of a shared subquery).
 */
export interface Dialect {
  readonly name: string;

  /** Quotes an identifier that has already been validated by the mapping. */
  quoteIdent(name: string): string;

  /** Placeholder for the bind value at `index` (1-based). */
  placeholder(index: number): string;

  /** Placeholders name their value (`$1`), so one value can be used several times. */
  readonly numberedPlaceholders: boolean;

  /** SQL for a bind value that holds JSON text and is written into a JSON column. */
  jsonInput(placeholder: string): string;

  /** Converts a JSON column or expression into JSON text in the result set. */
  jsonText(expr: string): string;

  /**
   * JSON text of the member `key` of the JSON object `objectExpr`, or SQL NULL when
   * the member is missing. `keyPlaceholder` is a bind value that holds `key`; the
   * key itself is passed only so the dialect can reject keys it cannot address
   * exactly. It must never be written into the SQL text.
   */
  jsonMember(objectExpr: string, keyPlaceholder: string, key: string): string;

  /**
   * The member `key` of the JSON object `objectExpr`, read as a native value of
   * `type`, for a property whose type the mapping declares. The key comes from
   * the mapping (never from a query) and is written into the SQL as a string
   * literal, so that an expression index on the same expression can be used.
   */
  typedMember(objectExpr: string, key: string, type: ScalarType): string;

  /** Condition: the JSON array of strings `labelsExpr` contains the bound label. */
  hasLabel(labelsExpr: string, labelPlaceholder: string): string;

  /**
   * A properties object with `patch` (a JSON object) merged in, as JSON merge
   * patch (RFC 7396) does at the top level: a null entry removes the key, any
   * other entry sets it. Property values are never maps, so nothing is merged
   * deeper. For SET and REMOVE.
   */
  mergeProperties(propertiesExpr: string, patch: string): string;

  /** A labels array with the label appended (the caller checks that it is not there yet). */
  appendLabel(labelsExpr: string, labelPlaceholder: string): string;

  /** A labels array without the label. */
  removeLabel(labelsExpr: string, labelPlaceholder: string): string;

  /** A bind placeholder holding a value of `type`, with the type made explicit. */
  typedPlaceholder(placeholder: string, type: 'integer' | 'float' | 'string'): string;

  /** A boolean literal; `null` is the unknown truth value. */
  booleanLiteral(value: boolean | null): string;

  /**
   * The Cypher type of a JSON value at run time, as SQL text: `null`, `boolean`,
   * `integer`, `float`, `string`, `list`, or `map`. SQL NULL for SQL NULL.
   */
  jsonType(json: string): string;

  /** Condition: the JSON value is null (SQL NULL or JSON null). */
  jsonIsNull(json: string): string;

  /**
   * A JSON scalar already known to be of `type`, as a native value. `number` is
   * an integer or float, as a value that compares exactly with either.
   */
  fromJson(json: string, type: ScalarType | 'number'): string;

  /** The JSON value of a native value of `type`. Floats keep a fraction (`2.0`). */
  toJson(value: string, type: ScalarType): string;

  /**
   * A float as text, as toString() writes it in Neo4j (Java's
   * `Double.toString`): the shortest digits that read back as the same
   * double, `1.5`, `2.0`, `1.0E20`, `1.0E-7`, `NaN`, `Infinity`.
   */
  floatToString(value: string): string;

  /** A string in upper or lower case (`toUpper`, `toLower`). */
  changeCase(string: string, to: 'upper' | 'lower'): string;

  /** A JSON list of JSON values. */
  jsonArray(items: string[]): string;

  /** A JSON map; keys are bind placeholders, values are JSON values. */
  jsonObject(entries: { keyPlaceholder: string; value: string }[]): string;

  /** Number of elements of a JSON value known to be a list. */
  listLength(json: string): string;

  /** Comparison of two strings by code point (binary collation). */
  compareStrings(
    left: string,
    operator: '=' | '<>' | '<' | '<=' | '>' | '>=',
    right: string,
  ): string;

  /** A string expression for ORDER BY, so that it sorts by code point. */
  orderString(string: string): string;

  startsWith(string: string, prefix: string): string;
  endsWith(string: string, suffix: string): string;
  contains(string: string, part: string): string;

  /**
   * Condition: the regular expression `pattern` (Java syntax, as in Cypher)
   * matches the whole `string`. Undefined when the database cannot match
   * regular expressions; `=~` is then an `UnsupportedFeatureError`.
   */
  readonly regexMatch: ((string: string, pattern: string) => string) | undefined;

  /** `base ^ exponent` as a float. */
  power(base: string, exponent: string): string;

  // ---- aggregates ------------------------------------------------------------------

  /**
   * Aggregate: a JSON list of the JSON values of the group's rows where `filter`
   * holds, in `orderBy` order (not together with `distinct`). `[]` for no rows.
   */
  jsonAggregate(
    value: string,
    options: { distinct: boolean; orderBy: string[]; filter: string },
  ): string;

  /** Aggregate: the texts of the group's rows concatenated in `orderBy` order; NULL for no rows. */
  stringAggregate(value: string, orderBy: string[]): string;

  // ---- sort keys (compared as text in byte order, see `orderString`) -------------

  /**
   * A text that sorts like the float `value`: `K` for -infinity, then negative
   * numbers (`L...`), `M` for zero, positive numbers (`N...`), `O` for infinity.
   * Fixed width within each sign, so a following key starts at the same place.
   */
  sortableNumber(value: string): string;
  /** A text that sorts like `string` and ends in a terminator lower than any of its characters. */
  sortableString(string: string): string;

  /** Aggregate: the smallest or largest boolean (false < true). */
  booleanAggregate(kind: 'min' | 'max', value: string): string;

  // ---- functions (arguments are non-null values of the stated type) --------------

  /** JSON list of the keys of a JSON map, sorted. */
  jsonKeys(map: string): string;
  /** A JSON map without the given keys (constants from the library, written as literals). */
  jsonRemoveKeys(map: string, keys: string[]): string;
  /**
   * Member of a JSON object by a key computed at run time (a SQL string, never
   * SQL text); NULL when missing or when the value is not an object.
   */
  jsonMemberAt(object: string, key: string): string;
  /** Element of a JSON list at an integer index (negative counts from the end); NULL if out of range. */
  jsonElement(list: string, index: string): string;
  /** A JSON list without its first element. */
  jsonTail(list: string): string;
  /** A JSON list in reverse order. */
  reverseList(list: string): string;
  reverseString(string: string): string;
  /** JSON list of the integers `start`, `start + step`, ... while not past `end`. */
  range(start: string, end: string, step: string): string;
  /** JSON list of the parts of a string between occurrences of a delimiter. */
  split(string: string, delimiter: string): string;
  /** Number of characters in a string. */
  stringLength(string: string): string;
  /** Characters from 0-based `start`, `length` of them or to the end. */
  substring(string: string, start: string, length: string | undefined): string;
  /** The last `count` characters. */
  rightString(string: string, count: string): string;
  /**
   * A string parsed as a number (surrounding whitespace allowed), or NULL if it
   * is not a number. For `integer`, a float string is truncated toward zero.
   */
  parseNumber(string: string, type: 'integer' | 'float'): string;
  /** A number as a float. */
  toFloat(number: string): string;
  /** A float truncated toward zero, as an integer. */
  truncate(float: string): string;
  /**
   * A math function by its Cypher name (`sqrt`, `exp`, `log`, `log10`, `sin`,
   * `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `floor`, `ceil`, `pi`, `e`,
   * `rand`). Arguments are floats; the result is a float.
   */
  math(name: string, args: string[]): string;

  /**
   * Float division. Dividing by zero gives infinity (or NaN for zero by zero)
   * instead of an error, as in Cypher. SQLite has no NaN; it gives NULL.
   */
  floatDivide(dividend: string, divisor: string): string;

  /** Concatenation of two JSON values known to be lists. */
  concatLists(left: string, right: string): string;

  /**
   * Cypher `=` on two JSON values, at any depth: false if they differ in type
   * (numbers compare by value), list length, map keys, or any pair of non-null
   * values; otherwise null if a null is compared; otherwise true.
   */
  jsonDeepEquals(left: string, right: string): string;

  /**
   * Clause to append to a derived table so that the optimizer does not flatten
   * it into the outer query. Flattening would copy the derived table's
   * expressions into every place that uses them, which grows exponentially for
   * nested expressions.
   */
  readonly noFlatten: string;

  // ---- entities as JSON values ------------------------------------------------------
  //
  // Inside JSON values (lists, maps, paths) a node or relationship is its
  // properties plus reserved keys, tagged with `~cypher` (see ENTITY_TAG), which
  // `jsonType` reports as `node`, `relationship`, or `path`. Properties are at the
  // top level, so property access works as on a map:
  //
  //   {"~cypher": "node", "~id": ..., "~labels": [...], <properties>}
  //   {"~cypher": "relationship", "~id": ..., "~type": ..., "~start": ..., "~end": ..., <properties>}
  //   {"~cypher": "path", "~nodes": [<node>, ...], "~relationships": [<relationship>, ...]}

  /** The tagged object of the node or relationship in the table alias `alias`. */
  entityJson(kind: 'node' | 'relationship', alias: string, table: EntityColumns): string;
  /** Condition: the id column equals the id held in a JSON value (a tagged object's `~id`). */
  jsonIdEquals(column: string, json: string): string;
  /** A tagged path from JSON lists of tagged nodes and relationships. */
  pathJson(nodes: string, relationships: string): string;
  /**
   * A JSON list of the tagged entities whose ids are in the id list, in list
   * order; NULL when the list is NULL.
   */
  entityList(kind: 'node' | 'relationship', list: string, table: EntityColumns): string;

  // ---- id lists (variable-length patterns) --------------------------------------
  //
  // The relationships and nodes of a variable-length match are ordered lists of
  // ids, in whatever representation suits the database (an array of the id
  // column's type on PostgreSQL, JSON text on SQLite).

  /** An empty list of ids of the column `id` of `table`. */
  idListEmpty(table: string, id: string): string;
  /** The list with `id` appended. */
  idListAppend(list: string, id: string): string;
  /** Condition: the list contains `id`. */
  idListHas(list: string, id: string): string;
  /** Condition: the two lists have an id in common. */
  idListsOverlap(left: string, right: string): string;
  /** Number of ids in the list, as an integer. */
  idListLength(list: string): string;

  // ---- bound ids (shortest path searches) ---------------------------------------
  //
  // Ids found by an earlier step come back as a bound JSON array (`json`, already
  // passed through `jsonInput`). JSON has no id type, so each id is converted to
  // the type of the id column `id` (its unquoted name) of `table`.

  /** The JSON id `json` as a value of the type of the id column `id` of `table`. */
  jsonId(json: string, table: string, id: string): string;
  /** Condition: `column` is one of the ids in the JSON array `json`. */
  boundIdIn(column: string, json: string, table: string, id: string): string;
  /**
   * The rows of a JSON array of found paths `[{"s", "t", "r": [...], "n": [...]}]`
   * as `SELECT s, t, path, nodes`: the start and end node ids, and the id lists
   * (see above) of the relationships and of the nodes after the start.
   */
  boundPaths(
    json: string,
    nodes: { table: string; id: string },
    edges: { table: string; id: string },
  ): string;

  /**
   * The condition, marked as one that few rows meet, so that the query planner
   * starts a join there (SQLite's `likelihood`); unchanged where the planner
   * takes no such hint.
   */
  selective(condition: string): string;

  // ---- run-time errors ------------------------------------------------------------

  /**
   * An expression of `type` that fails when it is evaluated, with `marker`
   * (letters, digits, `!`, and `:`) in the database's error message. It is
   * never evaluated early (constant folding), so it can sit in a CASE branch.
   */
  raise(marker: string, type: ScalarType | 'json'): string;
  /**
   * The integer result `expr` of `+`, `-`, or `*`, or `overflow` (a `raise`)
   * where the database would not fail on overflow itself (SQLite turns the
   * result into a float).
   */
  checkedInteger(expr: string, overflow: string): string;

  /** A LIMIT value meaning no limit (an OFFSET without LIMIT needs it on SQLite). */
  readonly limitAll: string;

  /**
   * `UNWIND listExpr AS ...` as a FROM item named `alias`, cross-joined after the
   * earlier FROM items (it may refer to them). `listExpr` is a JSON value. A list
   * gives one row per element, in list order; a JSON `null` (or SQL NULL) gives no
   * rows; any other value gives one row holding that value.
   */
  unwind(
    listExpr: string,
    alias: string,
  ): {
    from: string;
    /** Condition the row must meet, if the dialect needs one. */
    where: string | undefined;
    /** JSON value of the element. */
    value: string;
    /** Expression that orders the rows in list order. */
    order: string;
    /** Position of the element in the list, from 0 (for lists only). */
    index: string;
  };
}

/** The node or edge table and its columns, as quoted SQL names. */
export interface EntityColumns {
  table: string;
  id: string;
  properties: string;
  /** Nodes only. */
  labels?: string;
  /** Relationships only. */
  type?: string;
  startId?: string;
  endId?: string;
}

/** Reserved key that tags nodes, relationships, and paths inside JSON values. */
export const ENTITY_TAG = '~cypher';

/**
 * Keys of tagged objects besides the entity's properties. They cannot be used
 * as property keys or as keys of maps in queries and parameters.
 */
export const RESERVED_KEYS = new Set([
  ENTITY_TAG,
  '~id',
  '~labels',
  '~type',
  '~start',
  '~end',
  '~nodes',
  '~relationships',
]);

/**
 * The reserved key/value pairs of an entity's tagged object, as SQL string
 * literals and column references; the properties are merged in by the dialect.
 */
export function entityFields(
  kind: 'node' | 'relationship',
  alias: string,
  t: EntityColumns,
  json: (column: string) => string,
): [string, string][] {
  const col = (name: string | undefined): string => `${alias}.${name!}`;
  const head: [string, string][] = [
    [`'${ENTITY_TAG}'`, `'${kind}'`],
    [`'~id'`, col(t.id)],
  ];
  if (kind === 'node') {
    return [...head, [`'~labels'`, json(col(t.labels))]];
  }
  return [
    ...head,
    [`'~type'`, col(t.type)],
    [`'~start'`, col(t.startId)],
    [`'~end'`, col(t.endId)],
  ];
}

/**
 * Java's `Double.toString` layout of a finite float, in SQL that runs on both
 * dialects. The arguments are cheap SQL expressions: `sign` is `''` or `'-'`,
 * `digits` the significant digits without trailing zeros (`''` for zero), and
 * `exponent` the integer power of ten of the first digit. From 10^-3 up to
 * 10^7 the number is written as a decimal (`123.45`, `0.001`), otherwise in
 * scientific notation (`1.2345E7`, `1.0E-4`); there is always a digit after
 * the point.
 */
export function javaFloatText(sign: string, digits: string, exponent: string): string {
  const rest = `(CASE WHEN length(${digits}) > 1 THEN substr(${digits}, 2) ELSE '0' END)`;
  return (
    `(CASE WHEN ${digits} = '' THEN ${sign} || '0.0' ` +
    `WHEN ${exponent} >= 7 OR ${exponent} < -3 THEN ` +
    `${sign} || substr(${digits}, 1, 1) || '.' || ${rest} || 'E' || ${exponent} ` +
    `WHEN ${exponent} >= 0 THEN ${sign} || substr(${digits} || '0000000', 1, ${exponent} + 1) || '.' || ` +
    `(CASE WHEN length(${digits}) > ${exponent} + 1 THEN substr(${digits}, ${exponent} + 2) ELSE '0' END) ` +
    `ELSE ${sign} || '0.' || substr('00', 1, -${exponent} - 1) || ${digits} END)`
  );
}

/** A string literal for a key from the mapping (validated not to contain `"`). */
export function sqlStringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}
