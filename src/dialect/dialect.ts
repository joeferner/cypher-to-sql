/**
 * SQL differences between databases. The planner builds SQL from these pieces,
 * so it never writes database-specific syntax itself.
 *
 * Every JSON-valued expression the planner selects is returned as JSON *text*
 * (see `jsonText`), and the assembler parses it. That keeps the int/float
 * distinction and works the same way on every driver.
 */
export interface Dialect {
  readonly name: string;

  /** Quotes an identifier that has already been validated by the mapping. */
  quoteIdent(name: string): string;

  /** Placeholder for the bind value at `index` (1-based). */
  placeholder(index: number): string;

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

  /** Condition: the JSON array of strings `labelsExpr` contains the bound label. */
  hasLabel(labelsExpr: string, labelPlaceholder: string): string;

  /**
   * Condition that is true exactly when two JSON values are equal in Cypher:
   * integers and floats compare by value (`1 = 1.0`), other types only with the
   * same type. It is never true when either side is SQL NULL or JSON null.
   */
  jsonEquals(left: string, right: string): string;

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
  };
}
