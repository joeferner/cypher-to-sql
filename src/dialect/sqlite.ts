import { UnsupportedFeatureError } from '../errors.js';
import type { Dialect } from './dialect.js';

/**
 * SQLite dialect. Requires SQLite 3.38 or newer for the `->` JSON operator.
 * JSON columns hold JSON text.
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
    hasLabel: (labelsExpr, labelPlaceholder) =>
      `EXISTS (SELECT 1 FROM json_each(${labelsExpr}) WHERE json_each.value = ${labelPlaceholder})`,
    unwind: (listExpr, alias) => ({
      from: `json_each(${listExpr}) AS ${alias}`,
      // json_each of a scalar gives one row with a NULL key. Keep it, except for null.
      where: `NOT (${alias}.key IS NULL AND ${alias}.type = 'null')`,
      // `value` is SQL-typed for scalars; turn it back into JSON text. json_quote
      // keeps reals as reals (1.0), so integers and floats stay distinct.
      value:
        `(CASE ${alias}.type WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' ` +
        `WHEN 'false' THEN 'false' WHEN 'array' THEN ${alias}.value ` +
        `WHEN 'object' THEN ${alias}.value ELSE json_quote(${alias}.value) END)`,
      order: `${alias}.key`,
    }),
  };
}
