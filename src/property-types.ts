import { SemanticError } from './errors.js';
import type { CypherValue } from './values.js';

/** Types a property can be declared with. Temporal values are ISO 8601 strings in JSON. */
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
 * Declared types by property key. A declared property holds only values of its
 * type (or is absent); CREATE rejects anything else. Undeclared keys accept any
 * property value.
 */
export type PropertyTypes = Readonly<Record<string, PropertyType>>;

export function isPropertyType(value: unknown): value is PropertyType {
  return (PROPERTY_TYPES as readonly unknown[]).includes(value);
}

/** `2024-02-29` */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `2024-02-29T13:45`, with optional seconds and fraction, and a required `Z` or offset. */
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Throws a `SemanticError` unless `value` (not null) fits the declared type.
 * There is no conversion: `1` is not a float and `1.0` is not an integer.
 */
export function checkDeclaredType(key: string, value: CypherValue, type: PropertyType): void {
  if (!matches(value, type)) {
    throw new SemanticError(
      `Property ${JSON.stringify(key)} is declared as ${type} in the mapping, but the value is ${describe(value)}`,
      { hint: hints[type] },
    );
  }
}

const hints: Record<PropertyType, string> = {
  string: 'Use a string value, or remove the property.',
  integer: 'Use an integer value (for example 1, not 1.0), or remove the property.',
  float: 'Use a float value (for example 1.0, not 1), or remove the property.',
  boolean: 'Use true or false, or remove the property.',
  date: "Use an ISO 8601 date string such as '2024-02-29'.",
  datetime: "Use an ISO 8601 date-time string with a time zone, such as '2024-02-29T13:45:00Z'.",
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
