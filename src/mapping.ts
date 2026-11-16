import { MappingError } from './errors.js';
import { isPropertyType, PROPERTY_TYPES, type PropertyTypes } from './property-types.js';

/**
 * Table and column names for the generic storage layout:
 * one node table and one edge table, with labels and properties stored as JSON.
 */
export interface GraphMapping {
  /** Optional schema (PostgreSQL) or attached-database (SQLite) name that prefixes both tables. */
  schema?: string | undefined;
  /**
   * Optional prefix of every table name of the graph (the node and edge tables,
   * and the version table of `migrate`), so that several graphs can share one
   * database: `prefix: 'g1_'` reads `g1_nodes` and `g1_edges`.
   */
  prefix?: string | undefined;
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
 * the declared property types. Returns the mapping with the prefix applied: its
 * table names are the full names, and `prefix` is the one it had (for the
 * version table of `migrate`), never applied again.
 */
export function validateMapping(mapping: GraphMapping): ResolvedMapping {
  if (isResolved(mapping)) {
    return mapping;
  }
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
  if (mapping.prefix !== undefined && mapping.prefix !== '') {
    check('prefix', mapping.prefix);
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
  const prefix = mapping.prefix ?? '';
  const resolved: ResolvedMapping = {
    ...mapping,
    nodes: { ...mapping.nodes, table: `${prefix}${mapping.nodes.table}` },
    edges: { ...mapping.edges, table: `${prefix}${mapping.edges.table}` },
    prefix,
  };
  RESOLVED.add(resolved);
  return resolved;
}

/** A mapping whose table names include its prefix (see `validateMapping`). */
export type ResolvedMapping = GraphMapping & { prefix: string };

const RESOLVED = new WeakSet<GraphMapping>();

function isResolved(mapping: GraphMapping): mapping is ResolvedMapping {
  return RESOLVED.has(mapping);
}

function checkPropertyTypes(path: string, types: unknown): void {
  if (typeof types !== 'object' || types === null || Array.isArray(types)) {
    throw new MappingError(`Mapping value ${path} must be an object of property key to type`);
  }
  for (const [key, type] of Object.entries(types)) {
    if (key === '') {
      throw new MappingError(`Mapping value ${path} has an empty property key`);
    }
    // Declared keys are written into SQL (as string literals and JSON paths) so
    // that expression indexes match; a double quote cannot be addressed exactly.
    if (key.includes('"') || [...key].some((c) => c.charCodeAt(0) < 0x20)) {
      throw new MappingError(
        `Mapping value ${path} has a key with a double quote or control character: ${JSON.stringify(key)}`,
      );
    }
    if (!isPropertyType(type)) {
      throw new MappingError(
        `Mapping value ${path}.${key} must be one of ${PROPERTY_TYPES.join(', ')}, got ${JSON.stringify(type)}`,
      );
    }
  }
}
