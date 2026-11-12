import { MappingError } from './errors.js';
import { isPropertyType, PROPERTY_TYPES, type PropertyTypes } from './property-types.js';

/**
 * Table and column names for the generic storage layout:
 * one node table and one edge table, with labels and properties stored as JSON.
 */
export interface GraphMapping {
  /** Optional schema (PostgreSQL) or attached-database (SQLite) name that prefixes both tables. */
  schema?: string | undefined;
  nodes: {
    table: string;
    id: string;
    /** JSON array of label strings. */
    labels: string;
    /** JSON object of properties. */
    properties: string;
    /** Declared types of node properties, by key, for every label. */
    propertyTypes?: PropertyTypes | undefined;
  };
  edges: {
    table: string;
    id: string;
    startId: string;
    endId: string;
    type: string;
    /** JSON object of properties. */
    properties: string;
    /** Declared types of relationship properties, by key, for every relationship type. */
    propertyTypes?: PropertyTypes | undefined;
  };
}

export const defaultMapping: GraphMapping = {
  nodes: { table: 'nodes', id: 'id', labels: 'labels', properties: 'properties' },
  edges: {
    table: 'edges',
    id: 'id',
    startId: 'start_id',
    endId: 'end_id',
    type: 'type',
    properties: 'properties',
  },
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks that every name in the mapping is a plain SQL identifier. Identifiers are
 * the only text in emitted SQL that does not come from the library itself, so this
 * keeps the output free of injected SQL even for an untrusted mapping. Also checks
 * the declared property types.
 */
export function validateMapping(mapping: GraphMapping): GraphMapping {
  const check = (path: string, value: unknown): void => {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
      throw new MappingError(
        `Mapping value ${path} must be a SQL identifier matching ${IDENTIFIER.source}, got ${JSON.stringify(value)}`,
      );
    }
  };
  if (mapping.schema !== undefined) {
    check('schema', mapping.schema);
  }
  for (const kind of ['nodes', 'edges'] as const) {
    const { propertyTypes, ...columns } = mapping[kind];
    for (const [key, value] of Object.entries(columns)) {
      check(`${kind}.${key}`, value);
    }
    if (propertyTypes !== undefined) {
      checkPropertyTypes(`${kind}.propertyTypes`, propertyTypes);
    }
  }
  return mapping;
}

function checkPropertyTypes(path: string, types: unknown): void {
  if (typeof types !== 'object' || types === null || Array.isArray(types)) {
    throw new MappingError(`Mapping value ${path} must be an object of property key to type`);
  }
  for (const [key, type] of Object.entries(types)) {
    if (key === '') {
      throw new MappingError(`Mapping value ${path} has an empty property key`);
    }
    if (!isPropertyType(type)) {
      throw new MappingError(
        `Mapping value ${path}.${key} must be one of ${PROPERTY_TYPES.join(', ')}, got ${JSON.stringify(type)}`,
      );
    }
  }
}
