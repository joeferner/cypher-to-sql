// The TCK's value notation, as used in result tables and parameter tables:
//
//   null  true  1  -1.5  'str'  [1, 2]  {k: 'v'}
//   (:A:B {k: 1})   [:T {k: 1}]   <(:A)-[:T]->(:B)<-[:U]-()>
//
// Both expected cells (parsed from text) and actual results (converted from
// CypherValue) become a `TckValue`, which `canonical` turns into a string for
// comparison. Map keys and node labels are unordered, so `canonical` sorts them.

import {
  CypherNode,
  CypherPath,
  CypherRelationship,
  CypherTemporal,
  type CypherMap,
  type CypherValue,
} from '../../src/index.js';

export type TckValue =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'int'; v: bigint }
  | { t: 'float'; v: number }
  | { t: 'string'; v: string }
  | { t: 'list'; items: TckValue[] }
  | { t: 'map'; entries: Map<string, TckValue> }
  | TckNode
  | TckRelationship
  | {
      t: 'path';
      start: TckNode;
      segments: { rel: TckRelationship; forward: boolean; node: TckNode }[];
    };

interface TckNode {
  t: 'node';
  labels: string[];
  props: Map<string, TckValue>;
}

interface TckRelationship {
  t: 'rel';
  type: string;
  props: Map<string, TckValue>;
}

// ---- parsing -------------------------------------------------------------------

export function parseTckValue(text: string): TckValue {
  const parser = new Parser(text);
  const value = parser.value();
  parser.ws();
  if (!parser.done()) {
    throw parser.error('Unexpected trailing text');
  }
  return value;
}

class Parser {
  private i = 0;

  public constructor(private readonly s: string) {}

  public done(): boolean {
    return this.i >= this.s.length;
  }

  public error(message: string): Error {
    return new Error(`${message} at ${this.i} in TCK value ${JSON.stringify(this.s)}`);
  }

  public ws(): void {
    while (/\s/.test(this.s[this.i] ?? '')) {
      this.i++;
    }
  }

  private peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }

  private eat(token: string): boolean {
    this.ws();
    if (this.s.startsWith(token, this.i)) {
      this.i += token.length;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.eat(token)) {
      throw this.error(`Expected ${JSON.stringify(token)}`);
    }
  }

  public value(): TckValue {
    const c = this.peek();
    if (c === '[') {
      // A list, or a relationship `[:T ...]`.
      const save = this.i;
      this.i++;
      if (this.peek() === ':') {
        this.i = save;
        return this.relationship();
      }
      this.i = save;
      return this.list();
    }
    if (c === '{') {
      return { t: 'map', entries: this.map() };
    }
    if (c === '(') {
      return this.node();
    }
    if (c === '<') {
      return this.path();
    }
    if (c === "'") {
      return { t: 'string', v: this.string() };
    }
    return this.scalar();
  }

  private list(): TckValue {
    this.expect('[');
    const items: TckValue[] = [];
    if (!this.eat(']')) {
      do {
        items.push(this.value());
      } while (this.eat(','));
      this.expect(']');
    }
    return { t: 'list', items };
  }

  private map(): Map<string, TckValue> {
    this.expect('{');
    const entries = new Map<string, TckValue>();
    if (!this.eat('}')) {
      do {
        const key = this.name();
        this.expect(':');
        entries.set(key, this.value());
      } while (this.eat(','));
      this.expect('}');
    }
    return entries;
  }

  private node(): TckNode {
    this.expect('(');
    const labels: string[] = [];
    while (this.eat(':')) {
      labels.push(this.name());
    }
    const props = this.peek() === '{' ? this.map() : new Map<string, TckValue>();
    this.expect(')');
    return { t: 'node', labels, props };
  }

  private relationship(): TckRelationship {
    this.expect('[');
    this.expect(':');
    const type = this.name();
    const props = this.peek() === '{' ? this.map() : new Map<string, TckValue>();
    this.expect(']');
    return { t: 'rel', type, props };
  }

  private path(): TckValue {
    this.expect('<');
    const start = this.node();
    const segments: { rel: TckRelationship; forward: boolean; node: TckNode }[] = [];
    while (!this.eat('>')) {
      const backward = this.eat('<-');
      if (!backward) {
        this.expect('-');
      }
      const rel = this.relationship();
      const forward = this.eat('->');
      if (!forward) {
        this.expect('-');
      }
      if (forward === backward) {
        throw this.error('A path segment needs exactly one arrow head');
      }
      segments.push({ rel, forward, node: this.node() });
    }
    return { t: 'path', start, segments };
  }

  private name(): string {
    this.ws();
    if (this.s[this.i] === '`') {
      const end = this.s.indexOf('`', this.i + 1);
      const name = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return name;
    }
    const match = /^[\p{L}\p{N}_$]+/u.exec(this.s.slice(this.i));
    if (!match) {
      throw this.error('Expected a name');
    }
    this.i += match[0].length;
    return match[0];
  }

  private string(): string {
    this.expect("'");
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) {
        throw this.error('Unterminated string');
      }
      if (c === "'") {
        return out;
      }
      if (c === '\\') {
        const e = this.s[this.i++] ?? '';
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else {
        out += c;
      }
    }
  }

  private scalar(): TckValue {
    this.ws();
    const match = /^[^\s,\]})>]+/.exec(this.s.slice(this.i));
    if (!match) {
      throw this.error('Expected a value');
    }
    const word = match[0];
    this.i += word.length;
    if (word === 'null') {
      return { t: 'null' };
    }
    if (word === 'true' || word === 'false') {
      return { t: 'bool', v: word === 'true' };
    }
    if (/^-?\d+$/.test(word)) {
      return { t: 'int', v: BigInt(word) };
    }
    if (word === 'NaN') {
      return { t: 'float', v: NaN };
    }
    if (/^-?Inf(inity)?$/.test(word)) {
      return { t: 'float', v: word.startsWith('-') ? -Infinity : Infinity };
    }
    const float = Number(word);
    if (!Number.isNaN(float)) {
      return { t: 'float', v: float };
    }
    throw this.error(`Unknown value ${JSON.stringify(word)}`);
  }
}

// ---- conversion ----------------------------------------------------------------

export function fromCypher(value: CypherValue): TckValue {
  if (value === null) {
    return { t: 'null' };
  }
  switch (typeof value) {
    case 'boolean':
      return { t: 'bool', v: value };
    case 'bigint':
      return { t: 'int', v: value };
    case 'number':
      return { t: 'float', v: value };
    case 'string':
      return { t: 'string', v: value };
  }
  if (Array.isArray(value)) {
    return { t: 'list', items: value.map(fromCypher) };
  }
  if (value instanceof CypherNode) {
    return nodeFromCypher(value);
  }
  if (value instanceof CypherRelationship) {
    return relFromCypher(value);
  }
  if (value instanceof CypherPath) {
    const [first, ...rest] = value.nodes;
    return {
      t: 'path',
      start: nodeFromCypher(first!),
      segments: value.relationships.map((rel, i) => ({
        rel: relFromCypher(rel),
        forward: rel.startNodeId === value.nodes[i]!.id,
        node: nodeFromCypher(rest[i]!),
      })),
    };
  }
  if (value instanceof CypherTemporal) {
    // The TCK writes temporal values as their text: '2015-07-21'.
    return { t: 'string', v: value.text };
  }
  return { t: 'map', entries: propsFromCypher(value) };
}

/** Converts a TCK value (from a parameter table) to a query parameter. */
export function toCypher(value: TckValue): CypherValue {
  switch (value.t) {
    case 'null':
      return null;
    case 'bool':
    case 'int':
    case 'float':
    case 'string':
      return value.v;
    case 'list':
      return value.items.map(toCypher);
    case 'map': {
      const map: CypherMap = {};
      for (const [k, v] of value.entries) {
        map[k] = toCypher(v);
      }
      return map;
    }
    default:
      throw new Error(`A ${value.t} cannot be a query parameter`);
  }
}

function nodeFromCypher(node: CypherNode): TckNode {
  return { t: 'node', labels: node.labels, props: propsFromCypher(node.properties) };
}

function relFromCypher(rel: CypherRelationship): TckRelationship {
  return { t: 'rel', type: rel.type, props: propsFromCypher(rel.properties) };
}

function propsFromCypher(props: CypherMap): Map<string, TckValue> {
  return new Map(Object.entries(props).map(([k, v]) => [k, fromCypher(v)]));
}

// ---- canonical form ------------------------------------------------------------

export interface CanonicalOptions {
  /** "ignoring element order for lists": compare lists as multisets. */
  unorderedLists?: boolean;
}

export function canonical(value: TckValue, options: CanonicalOptions = {}): string {
  const c = (v: TckValue): string => canonical(v, options);
  const props = (m: Map<string, TckValue>): string =>
    m.size === 0
      ? ''
      : ` {${[...m.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k}: ${c(v)}`)
          .join(', ')}}`;
  const node = (n: TckNode): string =>
    `(${[...n.labels]
      .sort()
      .map((l) => `:${l}`)
      .join('')}${props(n.props)})`;
  const rel = (r: TckRelationship): string => `[:${r.type}${props(r.props)}]`;

  switch (value.t) {
    case 'null':
      return 'null';
    case 'bool':
      return String(value.v);
    case 'int':
      return value.v.toString();
    case 'float':
      // Always mark floats, so that 1 (integer) and 1.0 (float) never compare equal.
      return Number.isInteger(value.v) ? value.v.toFixed(1) : `${value.v}f`;
    case 'string':
      return JSON.stringify(value.v);
    case 'list': {
      const items = value.items.map(c);
      if (options.unorderedLists) {
        items.sort();
      }
      return `[${items.join(', ')}]`;
    }
    case 'map':
      return `{${props(value.entries).slice(2, -1)}}`;
    case 'node':
      return node(value);
    case 'rel':
      return rel(value);
    case 'path':
      return `<${node(value.start)}${value.segments
        .map((s) => (s.forward ? `-${rel(s.rel)}->` : `<-${rel(s.rel)}-`) + node(s.node))
        .join('')}>`;
  }
}
