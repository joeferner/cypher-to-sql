// Loading and deleting nodes and relationships in bulk, without Cypher (#89):
// a few set-based statements per chunk of input, instead of statements per row.
// Values are checked and encoded as Cypher writes them, so callers never see
// the storage format.

import type { Dialect } from './dialect/dialect.js';
import {
  CypherArgumentError,
  CypherConstraintError,
  CypherTypeError,
  LimitExceededError,
  SemanticError,
  type SourcePosition,
} from './errors.js';
import type { Row, SqlExecutor, SqlTx } from './executor.js';
import { stringifyCypherJson } from './json.js';
import type { Limits } from './limits.js';
import type { ResolvedMapping } from './mapping.js';
import { checkValue } from './parameters.js';
import { checkPropertyValue, patchEntries, uniqueViolation } from './plan.js';
import type { IdStrategy } from './planner/write.js';
import type { DeclaredTypes as PropertyTypes, PropertyType } from './property-types.js';
import { idJson, idsJson } from './search.js';
import type { CypherMap, CypherValue } from './values.js';

/** A node to write. */
export interface BulkNode {
  labels: readonly string[];
  /** Its properties; a null (or undefined) value means the key is absent. */
  properties?: Readonly<Record<string, unknown>> | undefined;
}

/** The nodes a relationship's end is: those with the label (if any) and these property values. */
export interface BulkEndpoint {
  label?: string | undefined;
  match: Readonly<Record<string, unknown>>;
}

/** A relationship to create between every pair of nodes its ends match. */
export interface BulkRelationship {
  type: string;
  start: BulkEndpoint;
  end: BulkEndpoint;
  properties?: Readonly<Record<string, unknown>> | undefined;
}

export interface BulkWriteInput {
  nodes?: readonly BulkNode[] | undefined;
  relationships?: readonly BulkRelationship[] | undefined;
}

export interface BulkWriteOptions {
  /**
   * The key of the nodes of a label, by label: declared properties
   * (`propertyTypes`) whose values identify a node of that label. A node with
   * the key of an existing node with the label is written into it (see
   * `onConflict`); without a key for its label, every node is inserted. Declare
   * an index on the keys (`indexes`) so that the lookups use it.
   */
  nodeKey?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * A node whose key exists already (or appeared earlier in the input):
   * `merge` (the default) sets its properties as `SET n += properties` does,
   * so a null removes the key; `replace` as `SET n = properties`; `ignore`
   * leaves it; `error` refuses the call with a `CypherConstraintError`. Labels
   * are added for `merge` and `replace`.
   */
  onConflict?: 'merge' | 'replace' | 'ignore' | 'error' | undefined;
  /** A relationship whose start or end matches no node: `skip` it (the default), or refuse the call. */
  missingEndpoint?: 'skip' | 'error' | undefined;
  /** Input rows per statement. Default 5,000. */
  chunkSize?: number | undefined;
}

export interface BulkWriteResult {
  nodesCreated: number;
  /** Existing nodes that the input changed (`merge`, `replace`). */
  nodesUpdated: number;
  relationshipsCreated: number;
  /** Input relationships that were not created because an end matched no node. */
  relationshipsSkipped: number;
}

export interface BulkDeleteInput {
  /** The nodes with the label (if any) and the property values (if any). */
  nodes?: { label?: string | undefined; match?: Readonly<Record<string, unknown>> } | undefined;
  /** The relationships with the type (if any) and the property values (if any). */
  relationships?:
    { type?: string | undefined; match?: Readonly<Record<string, unknown>> } | undefined;
  /** Delete the relationships of the deleted nodes too; without it, a node with relationships is an error. */
  detach?: boolean | undefined;
}

export interface BulkDeleteResult {
  nodesDeleted: number;
  relationshipsDeleted: number;
}

/** What a bulk operation runs with: the graph's dialect, mapping, executor, ids, and limits. */
export interface BulkContext {
  dialect: Dialect;
  mapping: ResolvedMapping;
  executor: SqlExecutor;
  idStrategy: IdStrategy;
  limits: Limits;
}

const DEFAULT_CHUNK = 5_000;
const NO_POSITION: SourcePosition = { line: 0, column: 0, offset: 0 };

/** Bind values written as markers, numbered in the order they appear in the SQL text. */
class Params {
  private readonly values: unknown[] = [];

  public constructor(private readonly d: Dialect) {}

  public add(value: unknown): string {
    this.values.push(value);
    return `${this.values.length - 1}`;
  }

  public finish(sql: string): { sql: string; values: unknown[] } {
    const values: unknown[] = [];
    const text = sql.replace(/(\d+)/g, (_m, i: string) => {
      values.push(this.values[Number(i)]);
      return this.d.placeholder(values.length);
    });
    return { sql: text, values };
  }
}

function invalid(message: string): CypherArgumentError {
  return new CypherArgumentError(message, { code: 'InvalidArgumentValue' });
}

/** A JavaScript value as a Cypher value (`checkValue`: no Date, NaN, functions...). */
function cypher(value: unknown, subject: string): CypherValue {
  return checkValue(value, (path) => `${subject}${path}`, undefined);
}

/**
 * Runs a conversion for declared property types, whose mismatch (a
 * `SemanticError` for a query) is a `CypherTypeError` that names the input.
 */
function declared<T>(subject: string, convert: () => T): T {
  try {
    return convert();
  } catch (error) {
    if (error instanceof SemanticError) {
      throw new CypherTypeError(`${subject}: ${error.message}`, { code: 'InvalidArgumentType' });
    }
    throw error;
  }
}

/** Properties as stored: checked and converted for their declared types, nulls left out. */
function storedProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
  types: PropertyTypes | undefined,
  subject: string,
): CypherMap {
  const value = cypher(properties ?? {}, subject);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${subject} must be a map of properties`);
  }
  const out: CypherMap = {};
  for (const [key, v] of Object.entries(value as CypherMap)) {
    if (v !== null) {
      out[key] = declared(subject, () => checkPropertyValue(key, v, types));
    }
  }
  return out;
}

/** The patch `SET n += properties` merges: nulls kept, so that they remove keys. */
function mergePatch(
  properties: Readonly<Record<string, unknown>> | undefined,
  types: PropertyTypes | undefined,
  subject: string,
): CypherMap {
  return declared(subject, () =>
    patchEntries(
      { mode: 'merge', key: undefined, types, position: NO_POSITION },
      cypher(properties ?? {}, subject),
    ),
  );
}

function labelsOf(labels: unknown, subject: string): string[] {
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l === '')) {
    throw invalid(`${subject}.labels must be a list of label names`);
  }
  return [...new Set(labels as string[])];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** SQL text of a table of the mapping, qualified with its schema. */
function tableName(c: BulkContext, kind: 'nodes' | 'edges'): string {
  const q = (name: string): string => c.dialect.quoteIdent(name);
  return c.mapping.schema
    ? `${q(c.mapping.schema)}.${q(c.mapping[kind].table)}`
    : q(c.mapping[kind].table);
}

/**
 * `column = value` for a property of the entity `alias` against the member
 * `member` of the JSON object `row`: typed (and served by the property's
 * index) for a declared key, as JSON values otherwise.
 */
function propertyEquals(
  c: BulkContext,
  kind: 'nodes' | 'edges',
  alias: string,
  key: string,
  row: string,
  member: string,
): string {
  const d = c.dialect;
  const properties = `${alias}.${d.quoteIdent(c.mapping[kind].properties)}`;
  const type = c.mapping[kind].propertyTypes?.[key];
  if (type === 'string' || type === 'integer' || type === 'float' || type === 'boolean') {
    const stored = d.typedMember(properties, key, type);
    const given = d.typedMember(row, member, type);
    return type === 'string' ? d.compareStrings(stored, '=', given) : `(${stored} = ${given})`;
  }
  return d.jsonDeepEquals(d.jsonLiteralMember(properties, key), d.jsonLiteralMember(row, member));
}

/** A label condition for the node `alias`, with the label bound. */
function hasLabel(c: BulkContext, p: Params, alias: string, label: string): string {
  return c.dialect.hasLabel(
    `${alias}.${c.dialect.quoteIdent(c.mapping.nodes.labels)}`,
    p.add(label),
  );
}

/** Runs statements and checks the time limit between them. */
class Runner {
  private readonly started = performance.now();

  public constructor(
    private readonly tx: SqlTx,
    private readonly limits: Limits,
  ) {}

  public async run(p: Params, sql: string): Promise<Row[]> {
    if (performance.now() - this.started > this.limits.timeoutMs) {
      throw new LimitExceededError(
        `The bulk operation ran longer than ${this.limits.timeoutMs} ms (timeoutMs)`,
        {
          hint: 'Write less per call, or raise timeoutMs.',
        },
      );
    }
    const { sql: text, values } = p.finish(sql);
    try {
      return await this.tx.query(text, values);
    } catch (error) {
      throw (
        uniqueViolation(
          error,
          'A concurrent write may have stored the key first: retry the call, which then finds the node.',
        ) ?? error
      );
    }
  }
}

/** A node of the input, after duplicates of its key were combined in input order. */
interface Keyed {
  label: string;
  /** The key's values, as stored. */
  key: CypherValue[];
  labels: Set<string>;
  /** The properties if the node is new. */
  created: CypherMap;
  /** What to apply to an existing node: `merge` (nulls remove keys) or `replace`. */
  patch: CypherMap;
  index: number;
}

/**
 * Writes nodes, then relationships, in one write transaction: a SELECT that
 * finds the existing keyed nodes, one UPDATE for them, and one INSERT for the
 * new ones, per label and chunk; then per kind of relationship and chunk, a
 * SELECT of the pairs of nodes its ends match and one INSERT.
 */
export async function bulkWrite(
  c: BulkContext,
  input: BulkWriteInput,
  options: BulkWriteOptions = {},
): Promise<BulkWriteResult> {
  const nodes = input.nodes ?? [];
  const relationships = input.relationships ?? [];
  const onConflict = options.onConflict ?? 'merge';
  if (!['merge', 'replace', 'ignore', 'error'].includes(onConflict)) {
    throw invalid(`onConflict must be merge, replace, ignore, or error, not ${String(onConflict)}`);
  }
  const missingEndpoint = options.missingEndpoint ?? 'skip';
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw invalid('chunkSize must be a positive integer');
  }
  if (nodes.length + relationships.length > c.limits.maxCreatedEntities) {
    throw new LimitExceededError(
      `The bulk write has more than ${c.limits.maxCreatedEntities} nodes and relationships (maxCreatedEntities)`,
      { hint: 'Split the input into several calls, or raise maxCreatedEntities.' },
    );
  }
  const nodeTypes = c.mapping.nodes.propertyTypes;
  const keyTypes = new Map<string, PropertyType[]>();
  for (const [label, keys] of Object.entries(options.nodeKey ?? {})) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw invalid(`nodeKey.${label} must be a non-empty list of property keys`);
    }
    keyTypes.set(
      label,
      (keys as readonly string[]).map((key) => {
        const type = nodeTypes?.[key];
        if (type !== 'string' && type !== 'integer' && type !== 'float' && type !== 'boolean') {
          throw invalid(
            `nodeKey.${label} has ${JSON.stringify(key)}, which is not a property declared as a string, integer, float, or boolean`,
          );
        }
        return type;
      }),
    );
  }

  // Nodes without a key are inserted; nodes with one are combined by key, in input order.
  const plain: { labels: string[]; properties: CypherMap }[] = [];
  const keyed = new Map<string, Keyed>();
  nodes.forEach((node, i) => {
    const subject = `nodes[${i}]`;
    const labels = labelsOf(node.labels, subject);
    const properties = storedProperties(node.properties, nodeTypes, `${subject}.properties`);
    const keyLabels = labels.filter((l) => keyTypes.has(l));
    if (keyLabels.length > 1) {
      throw invalid(
        `${subject} has the labels ${keyLabels.join(' and ')}, which both have a nodeKey`,
      );
    }
    if (keyLabels.length === 0) {
      plain.push({ labels, properties });
      return;
    }
    const label = keyLabels[0]!;
    const keys = options.nodeKey![label]!;
    const key = keys.map((k) => {
      const value = properties[k];
      if (value === undefined) {
        throw invalid(`${subject} has no value for ${label}'s key ${JSON.stringify(k)}`);
      }
      return value;
    });
    const id = `${label}\u0000${stringifyCypherJson(key)}`;
    const earlier = keyed.get(id);
    if (!earlier) {
      keyed.set(id, {
        label,
        key,
        labels: new Set(labels),
        created: properties,
        patch:
          onConflict === 'replace'
            ? properties
            : mergePatch(node.properties, nodeTypes, `${subject}.properties`),
        index: i,
      });
      return;
    }
    // A later node with the same key: as if written after the earlier one.
    if (onConflict === 'error') {
      throw new CypherConstraintError(
        `${subject} has the same ${label} key as nodes[${earlier.index}]: ${stringifyCypherJson(key)}`,
        {
          code: 'ConstraintValidationFailed',
          hint: 'Remove the duplicate, or use onConflict merge.',
        },
      );
    }
    if (onConflict === 'ignore') {
      return;
    }
    labels.forEach((l) => earlier.labels.add(l));
    if (onConflict === 'replace') {
      earlier.created = properties;
      earlier.patch = properties;
      return;
    }
    const patch = mergePatch(node.properties, nodeTypes, `${subject}.properties`);
    earlier.patch = { ...earlier.patch, ...patch };
    const created = { ...earlier.created, ...patch };
    earlier.created = Object.fromEntries(Object.entries(created).filter(([, v]) => v !== null));
  });

  return c.executor.transaction('write', async (tx) => {
    const run = new Runner(tx, c.limits);
    const result: BulkWriteResult = {
      nodesCreated: 0,
      nodesUpdated: 0,
      relationshipsCreated: 0,
      relationshipsSkipped: 0,
    };
    const inserts: { labels: string[]; properties: CypherMap }[] = [...plain];

    // Keyed nodes: which exist, then one UPDATE for those and INSERTs for the rest.
    for (const label of keyTypes.keys()) {
      const entries = [...keyed.values()].filter((k) => k.label === label);
      for (const chunk of chunks(entries, chunkSize)) {
        const existing = await findNodes(c, run, label, options.nodeKey![label]!, chunk);
        const updates: { id: unknown; labels: string[]; patch: CypherMap }[] = [];
        chunk.forEach((entry, i) => {
          const found = existing.get(i);
          if (!found) {
            inserts.push({ labels: [...entry.labels], properties: entry.created });
            return;
          }
          if (onConflict === 'error') {
            throw new CypherConstraintError(
              `nodes[${entry.index}] has the key of an existing ${label}: ${stringifyCypherJson(entry.key)}`,
              {
                code: 'ConstraintValidationFailed',
                hint: 'Use onConflict merge, replace, or ignore.',
              },
            );
          }
          if (onConflict === 'ignore') {
            return;
          }
          for (const node of found) {
            updates.push({
              id: node.id,
              labels: [...new Set([...node.labels, ...entry.labels])],
              patch: entry.patch,
            });
          }
        });
        if (updates.length > 0) {
          await updateNodes(c, run, updates, onConflict === 'replace');
          result.nodesUpdated += updates.length;
        }
      }
    }
    for (const chunk of chunks(inserts, chunkSize)) {
      await insertNodes(c, run, chunk);
      result.nodesCreated += chunk.length;
    }

    // Relationships, grouped by the shape of their ends' matches.
    const groups = new Map<
      string,
      { index: number; rel: BulkRelationship; start: CypherValue[]; end: CypherValue[] }[]
    >();
    const shapes = new Map<string, { start: Shape; end: Shape }>();
    relationships.forEach((rel, i) => {
      const subject = `relationships[${i}]`;
      if (typeof rel.type !== 'string' || rel.type === '') {
        throw invalid(`${subject}.type must be a relationship type`);
      }
      const start = endpoint(c, rel.start, `${subject}.start`);
      const end = endpoint(c, rel.end, `${subject}.end`);
      if (start.values === undefined || end.values === undefined) {
        // A null in a match never matches, as in MATCH.
        if (missingEndpoint === 'error') {
          throw missing(subject);
        }
        result.relationshipsSkipped++;
        return;
      }
      const id = JSON.stringify([start.shape, end.shape]);
      shapes.set(id, { start: start.shape, end: end.shape });
      const group = groups.get(id) ?? [];
      group.push({ index: i, rel, start: start.values, end: end.values });
      groups.set(id, group);
    });
    for (const [id, group] of groups) {
      const shape = shapes.get(id)!;
      for (const chunk of chunks(group, chunkSize)) {
        const pairs = await findPairs(c, run, shape, chunk);
        const rows: { start: unknown; end: unknown; type: string; properties: CypherMap }[] = [];
        chunk.forEach((item, i) => {
          const found = pairs.get(i);
          if (!found) {
            if (missingEndpoint === 'error') {
              throw missing(`relationships[${item.index}]`);
            }
            result.relationshipsSkipped++;
            return;
          }
          const properties = storedProperties(
            item.rel.properties,
            c.mapping.edges.propertyTypes,
            `relationships[${item.index}].properties`,
          );
          for (const [s, e] of found) {
            rows.push({ start: s, end: e, type: item.rel.type, properties });
          }
        });
        if (
          result.nodesCreated + result.relationshipsCreated + rows.length >
          c.limits.maxCreatedEntities
        ) {
          throw new LimitExceededError(
            `The bulk write creates more than ${c.limits.maxCreatedEntities} nodes and relationships (maxCreatedEntities)`,
            { hint: 'Match fewer nodes per relationship end, or raise maxCreatedEntities.' },
          );
        }
        for (const part of chunks(rows, chunkSize)) {
          await insertRelationships(c, run, part);
          result.relationshipsCreated += part.length;
        }
      }
    }
    return result;
  });
}

function missing(subject: string): CypherConstraintError {
  return new CypherConstraintError(`${subject} has an end that matches no node`, {
    code: 'MissingEndpoint',
    hint: 'Write the end nodes first, or use missingEndpoint skip.',
  });
}

/** How a relationship end matches: its label and the keys of its match, in order. */
interface Shape {
  label: string | undefined;
  keys: string[];
}

/** An end's shape and its match values as stored (undefined when one is null: it matches nothing). */
function endpoint(
  c: BulkContext,
  end: BulkEndpoint | undefined,
  subject: string,
): { shape: Shape; values: CypherValue[] | undefined } {
  if (!end || typeof end.match !== 'object' || end.match === null) {
    throw invalid(`${subject} must be { label?, match }`);
  }
  if (end.label !== undefined && (typeof end.label !== 'string' || end.label === '')) {
    throw invalid(`${subject}.label must be a label name`);
  }
  const keys = Object.keys(end.match);
  if (keys.length === 0 && end.label === undefined) {
    throw invalid(`${subject} needs a label or a match`);
  }
  const values: CypherValue[] = [];
  for (const key of keys) {
    const value = cypher(end.match[key], `${subject}.match.${key}`);
    if (value === null) {
      return { shape: { label: end.label, keys }, values: undefined };
    }
    // As stored for a declared key (an integral number of an integer key is an integer).
    let stored: CypherValue = value;
    try {
      stored = checkPropertyValue(key, value, c.mapping.nodes.propertyTypes);
    } catch {
      // A value of another type than declared matches nothing; compared as given.
    }
    values.push(stored);
  }
  return { shape: { label: end.label, keys }, values };
}

/** For each entry (by position in `chunk`), the existing nodes with its label and key. */
async function findNodes(
  c: BulkContext,
  run: Runner,
  label: string,
  keys: readonly string[],
  chunk: Keyed[],
): Promise<Map<number, { id: unknown; labels: string[] }[]>> {
  const d = c.dialect;
  const p = new Params(d);
  const rows = `[${chunk
    .map((entry, i) =>
      stringifyCypherJson({
        i: BigInt(i),
        ...Object.fromEntries(entry.key.map((v, j) => [`k${j}`, v])),
      }),
    )
    .join(',')}]`;
  const u = d.unwind(d.jsonInput(p.add(rows)), 'x');
  const conditions = [
    hasLabel(c, p, 'n', label),
    ...keys.map((key, j) => propertyEquals(c, 'nodes', 'n', key, u.value, `k${j}`)),
  ];
  const nodes = c.mapping.nodes;
  const found = await run.run(
    p,
    `SELECT ${d.typedMember(u.value, 'i', 'integer')} AS i, n.${d.quoteIdent(nodes.id)} AS id, ` +
      `${d.jsonText(`n.${d.quoteIdent(nodes.labels)}`)} AS labels ` +
      `FROM ${u.from} JOIN ${tableName(c, 'nodes')} AS n ON ${conditions.join(' AND ')}` +
      (u.where ? ` WHERE ${u.where}` : ''),
  );
  const out = new Map<number, { id: unknown; labels: string[] }[]>();
  for (const row of found) {
    const i = Number(row['i']);
    const list = out.get(i) ?? [];
    list.push({ id: row['id'], labels: JSON.parse(String(row['labels'])) as string[] });
    out.set(i, list);
  }
  return out;
}

/** One UPDATE: each node's labels, and its properties merged with (or replaced by) its patch. */
async function updateNodes(
  c: BulkContext,
  run: Runner,
  updates: { id: unknown; labels: string[]; patch: CypherMap }[],
  replace: boolean,
): Promise<void> {
  const d = c.dialect;
  const p = new Params(d);
  const rows = `[${updates
    .map(
      (u) =>
        `{"id":${idJson(u.id)},"labels":${JSON.stringify(u.labels)},"p":${stringifyCypherJson(
          replace
            ? Object.fromEntries(Object.entries(u.patch).filter(([, v]) => v !== null))
            : u.patch,
        )}}`,
    )
    .join(',')}]`;
  const nodes = c.mapping.nodes;
  await run.run(
    p,
    d.updateFromJson(tableName(c, 'nodes'), nodes.id, d.jsonInput(p.add(rows)), [
      { column: nodes.labels, value: (row): string => d.jsonLiteralMember(row, 'labels') },
      {
        column: nodes.properties,
        value: (row, current): string =>
          replace
            ? d.jsonLiteralMember(row, 'p')
            : d.mergeProperties(current, d.jsonLiteralMember(row, 'p')),
      },
    ]),
  );
}

/** One INSERT of new nodes, in input order (ids from the generator when the graph has one). */
async function insertNodes(
  c: BulkContext,
  run: Runner,
  chunk: { labels: string[]; properties: CypherMap }[],
): Promise<void> {
  const d = c.dialect;
  const p = new Params(d);
  const generate = c.idStrategy.kind === 'generator' ? c.idStrategy.generate : undefined;
  const rows = `[${chunk
    .map(
      (n) =>
        `{${generate ? `"id":${idJson(generate('node'))},` : ''}"labels":${JSON.stringify(n.labels)},` +
        `"p":${stringifyCypherJson(n.properties)}}`,
    )
    .join(',')}]`;
  const u = d.unwind(d.jsonInput(p.add(rows)), 'x');
  const nodes = c.mapping.nodes;
  const table = tableName(c, 'nodes');
  const columns = [
    ...(generate
      ? [[nodes.id, d.jsonId(d.jsonLiteralMember(u.value, 'id'), table, nodes.id)]]
      : []),
    [nodes.labels, d.jsonLiteralMember(u.value, 'labels')],
    [nodes.properties, d.jsonLiteralMember(u.value, 'p')],
  ] as [string, string][];
  await run.run(
    p,
    `INSERT INTO ${table} (${columns.map(([n]) => d.quoteIdent(n)).join(', ')}) ` +
      `SELECT ${columns.map(([, v]) => v).join(', ')} FROM ${u.from}` +
      (u.where ? ` WHERE ${u.where}` : '') +
      ` ORDER BY ${u.order}`,
  );
}

/** For each relationship (by position in `chunk`), the pairs of node ids its ends match. */
async function findPairs(
  c: BulkContext,
  run: Runner,
  shape: { start: Shape; end: Shape },
  chunk: { start: CypherValue[]; end: CypherValue[] }[],
): Promise<Map<number, [unknown, unknown][]>> {
  const d = c.dialect;
  const p = new Params(d);
  const rows = `[${chunk
    .map((item, i) =>
      stringifyCypherJson({
        i: BigInt(i),
        ...Object.fromEntries(item.start.map((v, j) => [`s${j}`, v])),
        ...Object.fromEntries(item.end.map((v, j) => [`e${j}`, v])),
      }),
    )
    .join(',')}]`;
  const u = d.unwind(d.jsonInput(p.add(rows)), 'x');
  const join = (alias: string, end: Shape, prefix: string): string => {
    const conditions = [
      ...(end.label === undefined ? [] : [hasLabel(c, p, alias, end.label)]),
      ...end.keys.map((key, j) => propertyEquals(c, 'nodes', alias, key, u.value, `${prefix}${j}`)),
    ];
    return `JOIN ${tableName(c, 'nodes')} AS ${alias} ON ${conditions.length > 0 ? conditions.join(' AND ') : 'TRUE'}`;
  };
  const id = d.quoteIdent(c.mapping.nodes.id);
  const found = await run.run(
    p,
    `SELECT ${d.typedMember(u.value, 'i', 'integer')} AS i, a.${id} AS s, b.${id} AS e ` +
      `FROM ${u.from} ${join('a', shape.start, 's')} ${join('b', shape.end, 'e')}` +
      (u.where ? ` WHERE ${u.where}` : '') +
      ` ORDER BY ${u.order}, a.${id}, b.${id}`,
  );
  const out = new Map<number, [unknown, unknown][]>();
  for (const row of found) {
    const i = Number(row['i']);
    const list = out.get(i) ?? [];
    list.push([row['s'], row['e']]);
    out.set(i, list);
  }
  return out;
}

/** One INSERT of relationships, in order. */
async function insertRelationships(
  c: BulkContext,
  run: Runner,
  rows: { start: unknown; end: unknown; type: string; properties: CypherMap }[],
): Promise<void> {
  const d = c.dialect;
  const p = new Params(d);
  const generate = c.idStrategy.kind === 'generator' ? c.idStrategy.generate : undefined;
  const json = `[${rows
    .map(
      (r) =>
        `{${generate ? `"id":${idJson(generate('relationship'))},` : ''}"s":${idJson(r.start)},` +
        `"e":${idJson(r.end)},"t":${JSON.stringify(r.type)},"p":${stringifyCypherJson(r.properties)}}`,
    )
    .join(',')}]`;
  const u = d.unwind(d.jsonInput(p.add(json)), 'x');
  const edges = c.mapping.edges;
  const nodes = tableName(c, 'nodes');
  const table = tableName(c, 'edges');
  const columns = [
    ...(generate
      ? [[edges.id, d.jsonId(d.jsonLiteralMember(u.value, 'id'), table, edges.id)]]
      : []),
    [edges.startId, d.jsonId(d.jsonLiteralMember(u.value, 's'), nodes, c.mapping.nodes.id)],
    [edges.endId, d.jsonId(d.jsonLiteralMember(u.value, 'e'), nodes, c.mapping.nodes.id)],
    [edges.type, d.typedMember(u.value, 't', 'string')],
    [edges.properties, d.jsonLiteralMember(u.value, 'p')],
  ] as [string, string][];
  await run.run(
    p,
    `INSERT INTO ${table} (${columns.map(([n]) => d.quoteIdent(n)).join(', ')}) ` +
      `SELECT ${columns.map(([, v]) => v).join(', ')} FROM ${u.from}` +
      (u.where ? ` WHERE ${u.where}` : '') +
      ` ORDER BY ${u.order}`,
  );
}

/**
 * Deletes the relationships, then the nodes, that match, in one write
 * transaction: a SELECT of their ids, then DELETEs by id.
 */
export async function bulkDelete(
  c: BulkContext,
  input: BulkDeleteInput,
): Promise<BulkDeleteResult> {
  return c.executor.transaction('write', async (tx) => {
    const run = new Runner(tx, c.limits);
    const result: BulkDeleteResult = { nodesDeleted: 0, relationshipsDeleted: 0 };
    const d = c.dialect;
    if (input.relationships) {
      const ids = await matchIds(
        c,
        run,
        'edges',
        input.relationships.type,
        input.relationships.match,
        'relationships',
      );
      for (const chunk of chunks(ids, DEFAULT_CHUNK)) {
        const p = new Params(d);
        const edges = c.mapping.edges;
        await run.run(
          p,
          `DELETE FROM ${tableName(c, 'edges')} WHERE ` +
            d.boundIdIn(
              d.quoteIdent(edges.id),
              d.jsonInput(p.add(idsJson(chunk))),
              tableName(c, 'edges'),
              edges.id,
            ),
        );
      }
      result.relationshipsDeleted += ids.length;
    }
    if (input.nodes) {
      const ids = await matchIds(c, run, 'nodes', input.nodes.label, input.nodes.match, 'nodes');
      const edges = c.mapping.edges;
      const nodes = tableName(c, 'nodes');
      for (const chunk of chunks(ids, DEFAULT_CHUNK)) {
        const ends = (p: Params): string => {
          const json = d.jsonInput(p.add(idsJson(chunk)));
          return (
            `(${d.boundIdIn(d.quoteIdent(edges.startId), json, nodes, c.mapping.nodes.id)} OR ` +
            `${d.boundIdIn(d.quoteIdent(edges.endId), json, nodes, c.mapping.nodes.id)})`
          );
        };
        const p = new Params(d);
        const attached = await run.run(
          p,
          `SELECT ${d.quoteIdent(edges.id)} AS id FROM ${tableName(c, 'edges')} WHERE ${ends(p)}`,
        );
        if (attached.length > 0) {
          if (!input.detach) {
            throw new CypherConstraintError(
              'Cannot delete a node that still has relationships; use detach',
              {
                code: 'DeleteConnectedNode',
              },
            );
          }
          const q = new Params(d);
          await run.run(q, `DELETE FROM ${tableName(c, 'edges')} WHERE ${ends(q)}`);
          result.relationshipsDeleted += attached.length;
        }
        const r = new Params(d);
        await run.run(
          r,
          `DELETE FROM ${nodes} WHERE ` +
            d.boundIdIn(
              d.quoteIdent(c.mapping.nodes.id),
              d.jsonInput(r.add(idsJson(chunk))),
              nodes,
              c.mapping.nodes.id,
            ),
        );
      }
      result.nodesDeleted += ids.length;
    }
    return result;
  });
}

/** The ids of the nodes with a label (or relationships with a type) and property values. */
async function matchIds(
  c: BulkContext,
  run: Runner,
  kind: 'nodes' | 'edges',
  name: string | undefined,
  match: Readonly<Record<string, unknown>> | undefined,
  subject: string,
): Promise<unknown[]> {
  const d = c.dialect;
  const p = new Params(d);
  const conditions: string[] = [];
  if (name !== undefined) {
    if (typeof name !== 'string' || name === '') {
      throw invalid(`${subject}.${kind === 'nodes' ? 'label' : 'type'} must be a name`);
    }
    conditions.push(
      kind === 'nodes'
        ? hasLabel(c, p, 't', name)
        : `t.${d.quoteIdent(c.mapping.edges.type)} = ${p.add(name)}`,
    );
  }
  const values: Record<string, CypherValue> = {};
  for (const [key, value] of Object.entries(match ?? {})) {
    const v = cypher(value, `${subject}.match.${key}`);
    if (v === null) {
      return []; // = null matches nothing.
    }
    let stored: CypherValue = v;
    try {
      stored = checkPropertyValue(key, v, c.mapping[kind].propertyTypes);
    } catch {
      // Another type than declared matches nothing; compared as given.
    }
    values[key] = stored;
  }
  if (Object.keys(values).length > 0) {
    const row = d.jsonInput(p.add(stringifyCypherJson(values)));
    for (const key of Object.keys(values)) {
      conditions.push(propertyEquals(c, kind, 't', key, row, key));
    }
  }
  const found = await run.run(
    p,
    `SELECT t.${d.quoteIdent(c.mapping[kind].id)} AS id FROM ${tableName(c, kind)} AS t` +
      (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''),
  );
  return found.map((r) => r['id']);
}
