// One text form for the values every engine returns, so that results compare
// as strings:
//
//   null  true  1  1.5  "str"  [1, 2]  {a: 1}
//   (:A:B {k: 1})  [:T {k: 1}]  <(:A)-[:T]->(:B)<-[:U]-()>
//
// Integers and floats stay apart (1 and 1.0 differ). Map keys and labels are
// sorted. Floats are rounded to 12 significant digits, since engines may sum
// in a different order. Entity ids differ between engines and are left out.

import neo4j from 'neo4j-driver';
import { CypherNode, CypherPath, CypherRelationship, type CypherValue } from '../src/index.js';

/** A row: column name to canonical value, columns sorted. */
export function canonicalRow(row: Record<string, string>): string {
  return `{${Object.keys(row)
    .sort()
    .map((k) => `${k}: ${row[k]}`)
    .join(', ')}}`;
}

export function float(n: number): string {
  if (Number.isNaN(n)) {
    return 'NaN';
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? 'Infinity' : '-Infinity';
  }
  const text = String(Number(n.toPrecision(12)) || 0);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const string = (s: string): string => JSON.stringify(s);
const list = (items: string[]): string => `[${items.join(', ')}]`;

function map(entries: [string, string][]): string {
  return `{${entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')}}`;
}

function properties(entries: [string, string][]): string {
  return entries.length === 0 ? '' : ` ${map(entries)}`;
}

function node(labels: string[], props: [string, string][]): string {
  return `(${[...labels]
    .sort()
    .map((l) => `:${l}`)
    .join('')}${properties(props)})`;
}

function relationship(type: string, props: [string, string][]): string {
  return `[:${type}${properties(props)}]`;
}

/** `nodes.length === rels.length + 1`; `forward[i]` when rels[i] goes from nodes[i] to nodes[i + 1]. */
function path(nodes: string[], rels: string[], forward: boolean[]): string {
  let text = `<${nodes[0]}`;
  rels.forEach((rel, i) => {
    text += forward[i] ? `-${rel}->${nodes[i + 1]}` : `<-${rel}-${nodes[i + 1]}`;
  });
  return `${text}>`;
}

// ---- this library ---------------------------------------------------------------

export function fromCypher(value: CypherValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return float(value);
  }
  if (typeof value === 'string') {
    return string(value);
  }
  if (Array.isArray(value)) {
    return list(value.map(fromCypher));
  }
  if (value instanceof CypherNode) {
    return node(value.labels, entries(value.properties, fromCypher));
  }
  if (value instanceof CypherRelationship) {
    return relationship(value.type, entries(value.properties, fromCypher));
  }
  if (value instanceof CypherPath) {
    return path(
      value.nodes.map(fromCypher),
      value.relationships.map(fromCypher),
      value.relationships.map((r, i) => r.startNodeId === value.nodes[i]!.id),
    );
  }
  return map(entries(value, fromCypher));
}

function entries<T>(object: Record<string, T>, f: (v: T) => string): [string, string][] {
  return Object.entries(object).map(([k, v]) => [k, f(v)]);
}

// ---- Neo4j (driver with useBigInt) ----------------------------------------------

export function fromNeo4j(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (neo4j.isInt(value)) {
    return value.toString();
  }
  if (typeof value === 'number') {
    return float(value);
  }
  if (typeof value === 'string') {
    return string(value);
  }
  if (Array.isArray(value)) {
    return list(value.map(fromNeo4j));
  }
  if (neo4j.isNode(value)) {
    return node(value.labels, entries(value.properties as Record<string, unknown>, fromNeo4j));
  }
  if (neo4j.isRelationship(value)) {
    return relationship(
      value.type,
      entries(value.properties as Record<string, unknown>, fromNeo4j),
    );
  }
  if (neo4j.isPath(value)) {
    const nodes = [value.start, ...value.segments.map((s) => s.end)];
    return path(
      nodes.map(fromNeo4j),
      value.segments.map((s) => fromNeo4j(s.relationship)),
      value.segments.map((s) => s.relationship.startNodeElementId === s.start.elementId),
    );
  }
  if (typeof value === 'object') {
    return map(entries(value as Record<string, unknown>, fromNeo4j));
  }
  throw new Error(`Unexpected Neo4j value of type ${typeof value}`);
}

// ---- ArcadeDB (HTTP JSON, parsed by parseJson) ----------------------------------

/** ArcadeDB's JSON as parsed by `parseJson`: integers are bigints, floats numbers. */
export type Json = null | boolean | bigint | number | string | Json[] | { [key: string]: Json };

export function fromArcade(value: Json): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return float(value);
  }
  if (typeof value === 'string') {
    return string(value);
  }
  if (Array.isArray(value)) {
    return list(value.map(fromArcade));
  }
  if (value['_type'] === 'path') {
    const nodes = value['nodes'] as { [key: string]: Json }[];
    const rels = value['relationships'] as { [key: string]: Json }[];
    return path(
      nodes.map(fromArcade),
      rels.map(fromArcade),
      rels.map((r, i) => r['@out'] === nodes[i]!['@rid']),
    );
  }
  const props = Object.entries(value)
    .filter(([k]) => !k.startsWith('@'))
    .map(([k, v]): [string, string] => [k, fromArcade(v)]);
  if (value['@cat'] === 'v') {
    return node(arcadeLabels(value['@type']), props);
  }
  if (value['@cat'] === 'e') {
    const type = value['@type'];
    return relationship(typeof type === 'string' ? type : '', props);
  }
  return map(props);
}

/** ArcadeDB names the type of a node with several labels `A~B`. */
function arcadeLabels(type: Json | undefined): string[] {
  return typeof type === 'string' && type !== '' ? type.split('~') : [];
}

/** JSON.parse, but integers become bigints and numbers with `.` or `e` stay floats. */
export function parseJson(text: string): Json {
  let i = 0;
  const ws = (): void => {
    while (/\s/.test(text[i] ?? '')) {
      i++;
    }
  };
  const fail = (): never => {
    throw new Error(`Bad JSON at ${i}: ${text.slice(i, i + 40)}`);
  };
  const value = (): Json => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const object: { [key: string]: Json } = {};
      ws();
      if (text[i] === '}') {
        i++;
        return object;
      }
      for (;;) {
        ws();
        const key = value();
        if (typeof key !== 'string') {
          fail();
        }
        ws();
        if (text[i++] !== ':') {
          fail();
        }
        object[key as string] = value();
        ws();
        const next = text[i++];
        if (next === '}') {
          return object;
        }
        if (next !== ',') {
          fail();
        }
      }
    }
    if (c === '[') {
      i++;
      const array: Json[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return array;
      }
      for (;;) {
        array.push(value());
        ws();
        const next = text[i++];
        if (next === ']') {
          return array;
        }
        if (next !== ',') {
          fail();
        }
      }
    }
    if (c === '"') {
      const match = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i)) ?? fail();
      i += match[0].length;
      return JSON.parse(match[0]) as string;
    }
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|NaN|-?Infinity)/.exec(
      text.slice(i),
    );
    if (!match) {
      return fail();
    }
    const token = match[0];
    i += token.length;
    switch (token) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
    }
    return /[.eE]/.test(token) ? Number(token) : BigInt(token);
  };
  const result = value();
  ws();
  if (i < text.length) {
    fail();
  }
  return result;
}

/** JSON text of a parameter value: bigints as integers, numbers always with a `.` or `e`. */
export function toJson(value: CypherValue): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    const text = String(value);
    return /[.e]/.test(text) ? text : `${text}.0`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(toJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${toJson(v as CypherValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
