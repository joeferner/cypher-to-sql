import { MappingError } from './errors.js';

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
  };
  edges: {
    table: string;
    id: string;
    startId: string;
    endId: string;
    type: string;
    /** JSON object of properties. */
    properties: string;
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
 * keeps the output free of injected SQL even for an untrusted mapping.
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
  for (const [key, value] of Object.entries(mapping.nodes)) {
    check(`nodes.${key}`, value);
  }
  for (const [key, value] of Object.entries(mapping.edges)) {
    check(`edges.${key}`, value);
  }
  return mapping;
}
