import { SemanticError } from './errors.js';
import { CypherDuration, CypherTemporal, type CypherValue } from './values.js';

/**
 * Types a property can be declared with. A `date` or `datetime` is stored as a
 * temporal value (the tagged JSON of `date(...)`), and writes also take its
 * ISO 8601 text.
 */
export const PROPERTY_TYPES = [
  'string',
  'integer',
  'float',
  'boolean',
  'date',
  'datetime',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * A declared property's type, and whether `migrate` and `schemaSql` give it an
 * index of its own (`indexed`, true by default). With `indexed: false` the type
 * still applies everywhere; the property can still be a key of a composite
 * index (`indexes`).
 */
export interface PropertyDeclaration {
  type: PropertyType;
  indexed?: boolean | undefined;
}

/**
 * Declared types by property key: a type (`'integer'`, indexed), or a
 * `PropertyDeclaration` (`{ type: 'string', indexed: false }`). A declared
 * property holds only values of its type (or is absent); CREATE rejects
 * anything else. Undeclared keys accept any property value.
 */
export type PropertyTypes = Readonly<Record<string, PropertyType | PropertyDeclaration>>;

/** Declared types by property key, as the library reads them (`validateMapping`). */
export type DeclaredTypes = Readonly<Record<string, PropertyType>>;

export function isPropertyType(value: unknown): value is PropertyType {
  return (PROPERTY_TYPES as readonly unknown[]).includes(value);
}

/** `2024-02-29` */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `2024-02-29T13:45`, with optional seconds and fraction, and a required `Z` or offset. */
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The value to store for a property declared as `type`: `value` (not null)
 * itself, or a `SemanticError` unless it fits. The one conversion is for
 * `integer`: a float with an integral value in JavaScript's safe range (`30`,
 * as JSON parsers and most JavaScript give integers, or `30.0`) is stored as
 * that integer, since the declaration settles which it is. `30.5`, or an
 * integral float beyond 2^53, is still an error, and `1` is not a float.
 *
 * A `date` or `datetime` takes a temporal value of that kind, or its ISO 8601
 * text (`'2024-02-29'`, `'2024-02-29T13:45:00Z'`), which becomes that value.
 * Except in MERGE (`merging`): its pattern matches stored dates only with a
 * date, so a string would never match and a node would be created on every run.
 */
export function declaredValue(
  key: string,
  value: CypherValue,
  type: PropertyType,
  merging = false,
): CypherValue {
  if (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (type === 'date' || type === 'datetime') {
    if (value instanceof CypherTemporal && value.kind === type) {
      return value;
    }
    if (typeof value === 'string' && matches(value, type)) {
      if (merging) {
        throw new SemanticError(
          `MERGE matches the ${type} property ${JSON.stringify(key)} only with a ${type}, not the string ${JSON.stringify(value)}`,
          {
            hint: `Use ${type}(${JSON.stringify(value).replaceAll('"', "'")}), or ${type}($value).`,
          },
        );
      }
      return new CypherTemporal(type, value);
    }
  }
  if (!matches(value, type)) {
    throw new SemanticError(
      `Property ${JSON.stringify(key)} is declared as ${type} in the mapping, but the value is ${describe(value)}`,
      { hint: hints[type] },
    );
  }
  return value;
}

const hints: Record<PropertyType, string> = {
  string: 'Use a string value, or remove the property.',
  integer:
    'Use an integer value (a float such as 30.5, or one beyond 2^53, is not converted), or remove the property.',
  float: 'Use a float value (for example 1.0, not 1), or remove the property.',
  boolean: 'Use true or false, or remove the property.',
  date: "Use a date, such as date('2024-02-29'), or its ISO 8601 text '2024-02-29'.",
  datetime:
    "Use a datetime, such as datetime('2024-02-29T13:45:00Z'), or its ISO 8601 text with a time zone.",
};

function matches(value: CypherValue, type: PropertyType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'bigint';
    case 'float':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date': {
      const m = typeof value === 'string' ? DATE.exec(value) : null;
      return m !== null && isCalendarDate(m[1]!, m[2]!, m[3]!);
    }
    case 'datetime': {
      const m = typeof value === 'string' ? DATETIME.exec(value) : null;
      return (
        m !== null &&
        isCalendarDate(m[1]!, m[2]!, m[3]!) &&
        Number(m[4]) <= 23 &&
        Number(m[5]) <= 59 &&
        Number(m[6] ?? 0) <= 59 &&
        Number(m[7] ?? 0) <= 18 &&
        Number(m[8] ?? 0) <= 59
      );
    }
  }
}

function isCalendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) {
    return false;
  }
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function describe(value: CypherValue): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (value instanceof CypherTemporal) {
    return `the ${value.kind} ${value.text}`;
  }
  if (value instanceof CypherDuration) {
    return `the duration ${value.text}`;
  }
  switch (typeof value) {
    case 'bigint':
      return `the integer ${value}`;
    case 'number':
      return `the float ${value}`;
    case 'string':
      return `the string ${JSON.stringify(value)}`;
    case 'boolean':
      return `the boolean ${value}`;
    default:
      return 'a map';
  }
}
