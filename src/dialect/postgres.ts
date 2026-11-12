import type { Dialect } from './dialect.js';

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
    // `@>` can use a GIN index on the labels column.
    hasLabel: (labelsExpr, labelPlaceholder) =>
      `(${labelsExpr} @> jsonb_build_array(${labelPlaceholder}::text))`,
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
