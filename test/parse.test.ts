import { describe, expect, it } from 'vitest';
import { CypherSyntaxError, parse, UnsupportedFeatureError, type ast } from '../src/index.js';

/** The only clause of the RETURN-only query `RETURN <expr>`, as its expression. */
function expr(text: string): ast.Expression {
  const ret = parse(`RETURN ${text}`).clauses[0] as ast.ReturnClause;
  return ret.items[0]!.expression;
}

function value(text: string): unknown {
  const e = expr(text);
  if (e.type !== 'Literal') {
    throw new Error(`Expected a literal, got ${e.type}`);
  }
  return e.value;
}

describe('parse: clauses', () => {
  it('builds MATCH and RETURN with positions', () => {
    const query = parse('MATCH (n:Person:Admin)\nRETURN n.name AS name, n LIMIT $max');
    expect(query.clauses).toMatchObject([
      {
        type: 'Match',
        position: { line: 1, column: 0, offset: 0 },
        optional: false,
        where: undefined,
        pattern: [
          {
            variable: undefined,
            elements: [{ type: 'NodePattern', variable: 'n', labels: ['Person', 'Admin'] }],
          },
        ],
      },
      {
        type: 'Return',
        position: { line: 2, column: 0, offset: 23 },
        distinct: false,
        star: false,
        items: [
          {
            alias: 'name',
            name: 'name',
            expression: {
              type: 'PropertyAccess',
              key: 'name',
              subject: { type: 'Variable', name: 'n' },
            },
          },
          { alias: undefined, name: 'n', expression: { type: 'Variable', name: 'n' } },
        ],
        limit: { type: 'Parameter', name: 'max' },
      },
    ]);
  });

  it('names a projection by its text as written', () => {
    const ret = parse('RETURN n.name ,  {a :1}').clauses[0] as ast.ReturnClause;
    expect(ret.items.map((i) => i.name)).toEqual(['n.name', '{a :1}']);
  });

  it('parses OPTIONAL MATCH, WHERE, DISTINCT, ORDER BY, SKIP, and RETURN *', () => {
    const query = parse('OPTIONAL MATCH (n) WHERE n.x RETURN DISTINCT * ORDER BY n DESC SKIP 1');
    expect(query.clauses).toMatchObject([
      { type: 'Match', optional: true, where: { type: 'PropertyAccess', key: 'x' } },
      {
        type: 'Return',
        distinct: true,
        star: true,
        items: [],
        orderBy: [{ descending: true, expression: { type: 'Variable', name: 'n' } }],
        skip: { type: 'Literal', value: 1n },
      },
    ]);
  });

  it('parses UNWIND and CREATE', () => {
    const query = parse('UNWIND [1, 2] AS x CREATE (a {v: x})-[:T]->(b)');
    expect(query.clauses).toMatchObject([
      { type: 'Unwind', variable: 'x', expression: { type: 'List' } },
      {
        type: 'Create',
        pattern: [
          {
            elements: [
              { type: 'NodePattern', variable: 'a', properties: { type: 'Map' } },
              { type: 'RelationshipPattern', types: ['T'], direction: 'right' },
              { type: 'NodePattern', variable: 'b' },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps unsupported clauses as nodes, marking write clauses', () => {
    const clauses = (text: string): unknown => parse(text).clauses[0];
    expect(clauses('MERGE (n)')).toMatchObject({
      type: 'UnsupportedClause',
      name: 'MERGE',
      write: true,
    });
    expect(clauses('MATCH (n) SET n.x = 1')).toBeDefined();
    expect(parse('MATCH (n) SET n.x = 1').clauses[1]).toMatchObject({ name: 'SET', write: true });
    expect(parse('MATCH (n) REMOVE n.x').clauses[1]).toMatchObject({ name: 'REMOVE', write: true });
    expect(parse('MATCH (n) DELETE n').clauses[1]).toMatchObject({ name: 'DELETE', write: true });
    expect(parse('MATCH (n) DETACH DELETE n').clauses[1]).toMatchObject({
      name: 'DETACH DELETE',
      write: true,
    });
    expect(parse('MATCH (n) CALL db.labels() YIELD label RETURN label').clauses[1]).toMatchObject({
      type: 'UnsupportedClause',
      name: 'CALL',
      write: false,
    });
  });

  it('rejects constructs that change the query shape', () => {
    expect(() => parse('CALL db.labels()')).toThrow(UnsupportedFeatureError);
    expect(() => parse('MATCH (n) WITH n RETURN n')).toThrow(/WITH is not supported/);
    expect(() => parse('RETURN 1 UNION RETURN 2')).toThrow(/UNION is not supported/);
  });

  it('reports syntax errors with a position', () => {
    try {
      parse('MATCH (n\nRETURN n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CypherSyntaxError);
      expect((error as CypherSyntaxError).position).toMatchObject({ line: 2 });
    }
  });
});

describe('parse: patterns', () => {
  const rel = (text: string): ast.RelationshipPattern => {
    const match = parse(`MATCH (a)${text}(b) RETURN a`).clauses[0] as ast.MatchClause;
    return match.pattern[0]!.elements[1] as ast.RelationshipPattern;
  };

  it('parses directions and types', () => {
    expect(rel('-->')).toMatchObject({ direction: 'right', types: [], variable: undefined });
    expect(rel('<-[r:A|B]-')).toMatchObject({
      direction: 'left',
      types: ['A', 'B'],
      variable: 'r',
    });
    expect(rel('-[r]-')).toMatchObject({ direction: 'both' });
    expect(rel('<-[r]->')).toMatchObject({ direction: 'both' });
  });

  it('parses variable-length ranges', () => {
    expect(rel('-[*]->').range).toEqual({ min: undefined, max: undefined });
    expect(rel('-[*2]->').range).toEqual({ min: 2, max: 2 });
    expect(rel('-[*1..3]->').range).toEqual({ min: 1, max: 3 });
    expect(rel('-[*..3]->').range).toEqual({ min: undefined, max: 3 });
    expect(rel('-[*2..]->').range).toEqual({ min: 2, max: undefined });
    expect(rel('-[:T]->').range).toBeUndefined();
  });

  it('parses named paths and parameter property maps', () => {
    const match = parse('MATCH p = (a $props) RETURN p').clauses[0] as ast.MatchClause;
    expect(match.pattern[0]).toMatchObject({
      variable: 'p',
      elements: [{ properties: { type: 'Parameter', name: 'props' } }],
    });
  });

  it('unescapes backquoted names', () => {
    const match = parse('MATCH (`my var`:`a``b`) RETURN 1').clauses[0] as ast.MatchClause;
    expect(match.pattern[0]!.elements[0]).toMatchObject({ variable: 'my var', labels: ['a`b'] });
  });
});

describe('parse: literals', () => {
  it('parses integers as bigint and floats as number', () => {
    expect(value('42')).toBe(42n);
    expect(value('-42')).toBe(-42n);
    expect(value('0x1F')).toBe(31n);
    expect(value('0o17')).toBe(15n);
    expect(value('1.5')).toBe(1.5);
    expect(value('1.0')).toBe(1);
    expect(value('-2e3')).toBe(-2000);
    expect(value('.5')).toBe(0.5);
  });

  it('accepts the full 64-bit range and rejects anything beyond', () => {
    expect(value('9223372036854775807')).toBe(9223372036854775807n);
    expect(value('-9223372036854775808')).toBe(-9223372036854775808n);
    expect(() => parse('RETURN 9223372036854775808')).toThrow(CypherSyntaxError);
    expect(() => parse('RETURN 1e999')).toThrow(CypherSyntaxError);
  });

  it('parses strings, booleans, null, lists, and maps', () => {
    expect(value(String.raw`'a\'b\né'`)).toBe("a'b\né");
    expect(value('"double"')).toBe('double');
    expect(value('true')).toBe(true);
    expect(value('NULL')).toBe(null);
    expect(expr('[1, [2]]')).toMatchObject({
      type: 'List',
      items: [{ value: 1n }, { type: 'List', items: [{ value: 2n }] }],
    });
    expect(expr('{a: 1, `b c`: null}')).toMatchObject({
      type: 'Map',
      entries: [
        { key: 'a', value: { value: 1n } },
        { key: 'b c', value: { value: null } },
      ],
    });
  });
});

describe('parse: unsupported expressions', () => {
  it.each([
    ['a OR b', 'OR'],
    ['a XOR b', 'XOR'],
    ['a AND b', 'AND'],
    ['NOT a', 'NOT'],
    ['a = 1', 'comparison operators'],
    ['a IS NULL', 'string, list, and null predicates'],
    ["a STARTS WITH 'x'", 'string, list, and null predicates'],
    ['1 + 2', 'arithmetic'],
    ['2 * 3', 'arithmetic'],
    ['2 ^ 3', 'arithmetic'],
    ['-a', 'unary minus'],
    ['a[0]', 'list indexing and slicing'],
    ['a:Label', 'label predicates'],
    ['CASE WHEN a THEN 1 END', 'CASE expressions'],
    ['count(*)', 'count(*)'],
    ['[x IN a | x]', 'list comprehensions'],
    ['[(a)-->(b) | b]', 'pattern comprehensions'],
    ['all(x IN a WHERE x)', 'list quantifiers (all, any, none, single)'],
    ['(a)-->()', 'pattern predicates'],
    ['size(a)', 'function calls'],
    ['EXISTS { (a)-->() }', 'EXISTS subqueries'],
  ])('%s → %s', (text, description) => {
    expect(expr(text)).toMatchObject({
      type: 'UnsupportedExpression',
      description,
      position: { line: 1, column: 7 },
    });
  });

  it('keeps unsupported expressions nested inside supported ones', () => {
    expect(expr('[1, a + 1]')).toMatchObject({
      type: 'List',
      items: [{ type: 'Literal' }, { type: 'UnsupportedExpression', description: 'arithmetic' }],
    });
  });
});
