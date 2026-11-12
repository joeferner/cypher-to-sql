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
}
