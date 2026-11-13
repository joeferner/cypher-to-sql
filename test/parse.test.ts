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

  it('parses SET and REMOVE items', () => {
    const position = expect.anything() as unknown;
    expect(
      parse('MATCH (n) SET n.a = 1, (n).b.c = 2, n = {x: 1}, n += $m, n:A:B').clauses[1],
    ).toMatchObject({
      type: 'Set',
      items: [
        {
          kind: 'property',
          target: { type: 'Variable', name: 'n' },
          key: 'a',
          value: { value: 1n },
        },
        {
          kind: 'property',
          target: { type: 'PropertyAccess', subject: { name: 'n' }, key: 'b' },
          key: 'c',
        },
        { kind: 'replace', variable: 'n', value: { type: 'Map' }, position },
        { kind: 'merge', variable: 'n', value: { type: 'Parameter', name: 'm' } },
        { kind: 'labels', variable: 'n', labels: ['A', 'B'] },
      ],
    });
    expect(parse('MATCH (n) REMOVE n.a, n:A').clauses[1]).toMatchObject({
      type: 'Remove',
      items: [
        { kind: 'property', target: { name: 'n' }, key: 'a' },
        { kind: 'labels', variable: 'n', labels: ['A'] },
      ],
    });
  });

  it('rejects constructs that change the query shape', () => {
    expect(() => parse('CALL db.labels()')).toThrow(UnsupportedFeatureError);
    expect(() => parse('RETURN 1 UNION RETURN 2')).toThrow(/UNION is not supported/);
  });

  it('parses query parts ending in WITH, in order', () => {
    const query = parse(
      'MATCH (n) WITH DISTINCT n.x AS x ORDER BY x SKIP 1 LIMIT 2 WHERE x > 0 UNWIND [x] AS y WITH * RETURN y',
    );
    expect(query.clauses.map((c) => c.type)).toEqual(['Match', 'With', 'Unwind', 'With', 'Return']);
    expect(query.clauses[1]).toMatchObject({
      type: 'With',
      distinct: true,
      items: [{ name: 'x', alias: 'x' }],
      orderBy: [{ expression: { type: 'Variable', name: 'x' } }],
      skip: { value: 1n },
      limit: { value: 2n },
      where: { type: 'Binary', operator: '>' },
    });
    expect(query.clauses[3]).toMatchObject({ type: 'With', star: true, where: undefined });
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

describe('parse: operators', () => {
  const v = (name: string): object => ({ type: 'Variable', name });
  const bin = (operator: string, left: object, right: object): object => ({
    type: 'Binary',
    operator,
    left,
    right,
  });

  it('gives boolean operators their precedence: NOT, AND, XOR, OR', () => {
    expect(expr('a OR b XOR c AND NOT d')).toMatchObject(
      bin('OR', v('a'), bin('XOR', v('b'), bin('AND', v('c'), { type: 'Not', operand: v('d') }))),
    );
    expect(expr('NOT NOT a')).toMatchObject({
      type: 'Not',
      operand: { type: 'Not', operand: v('a') },
    });
  });

  it('chains comparisons with AND', () => {
    expect(expr('a < b <= c')).toMatchObject(
      bin('AND', bin('<', v('a'), v('b')), bin('<=', v('b'), v('c'))),
    );
    expect(expr('a <> b')).toMatchObject(bin('<>', v('a'), v('b')));
  });

  it('gives arithmetic its precedence and left associativity', () => {
    expect(expr('a + b * c ^ d')).toMatchObject(
      bin('+', v('a'), bin('*', v('b'), bin('^', v('c'), v('d')))),
    );
    expect(expr('a - b - c')).toMatchObject(bin('-', bin('-', v('a'), v('b')), v('c')));
    expect(expr('a / b % c')).toMatchObject(bin('%', bin('/', v('a'), v('b')), v('c')));
  });

  it('folds a minus into number literals only', () => {
    expect(expr('-1')).toMatchObject({ type: 'Literal', value: -1n });
    expect(expr('-a')).toMatchObject({ type: 'Negate', operand: v('a') });
    expect(expr('-a.b')).toMatchObject({ type: 'Negate', operand: { type: 'PropertyAccess' } });
    expect(expr('- 2 ^ 2')).toMatchObject(bin('^', { value: -2n }, { value: 2n }));
  });

  it('parses string, list, and null predicates left to right', () => {
    expect(expr("a STARTS WITH 'x'")).toMatchObject(bin('STARTS WITH', v('a'), { value: 'x' }));
    expect(expr("a ENDS WITH 'x'")).toMatchObject({ operator: 'ENDS WITH' });
    expect(expr("a CONTAINS 'x'")).toMatchObject({ operator: 'CONTAINS' });
    expect(expr('a IN [1]')).toMatchObject(bin('IN', v('a'), { type: 'List' }));
    expect(expr('a IS NULL')).toMatchObject({ type: 'IsNull', negated: false, operand: v('a') });
    expect(expr('a IS NOT NULL')).toMatchObject({ type: 'IsNull', negated: true });
    expect(expr('a + 1 IS NULL')).toMatchObject({ type: 'IsNull', operand: { operator: '+' } });
  });

  it('parses label predicates', () => {
    expect(expr('n:A:B')).toMatchObject({ type: 'HasLabels', subject: v('n'), labels: ['A', 'B'] });
  });
});

describe('parse: function calls', () => {
  it('keeps the name as written, with its namespace, DISTINCT, and arguments', () => {
    expect(expr('toUpper(a, 1)')).toMatchObject({
      type: 'FunctionCall',
      name: 'toUpper',
      distinct: false,
      args: [
        { type: 'Variable', name: 'a' },
        { type: 'Literal', value: 1n },
      ],
    });
    expect(expr('my.ns.f(DISTINCT a)')).toMatchObject({ name: 'my.ns.f', distinct: true });
    expect(expr('rand()')).toMatchObject({ name: 'rand', args: [] });
  });

  it('parses count(*) on its own', () => {
    expect(expr('count(*)')).toMatchObject({ type: 'CountStar', position: { column: 7 } });
    expect(expr('count(DISTINCT a)')).toMatchObject({ type: 'FunctionCall', distinct: true });
  });
});

describe('parse: patterns in expressions', () => {
  it('parses pattern predicates', () => {
    expect(expr('(a)-[:T]->()')).toMatchObject({
      type: 'PatternPredicate',
      position: { line: 1, column: 7 },
      pattern: {
        variable: undefined,
        elements: [
          { type: 'NodePattern', variable: 'a' },
          { type: 'RelationshipPattern', types: ['T'], direction: 'right' },
          { type: 'NodePattern', variable: undefined },
        ],
      },
    });
  });

  it('parses EXISTS with a pattern or a query', () => {
    expect(expr('EXISTS { (a)-->(b), (b)-->() WHERE b.x }')).toMatchObject({
      type: 'Exists',
      pattern: [{ elements: [{ variable: 'a' }, {}, { variable: 'b' }] }, {}],
      where: { type: 'PropertyAccess', key: 'x' },
      query: undefined,
    });
    expect(expr('EXISTS { MATCH (a)-->(b) RETURN b }')).toMatchObject({
      type: 'Exists',
      pattern: undefined,
      query: { clauses: [{ type: 'Match' }, { type: 'Return' }] },
    });
  });

  it('parses pattern comprehensions, nested in other expressions', () => {
    expect(expr('[1, a + [p = (a)-->(b) WHERE b.x | b.y][0]]')).toMatchObject({
      type: 'List',
      items: [
        { type: 'Literal' },
        {
          type: 'Binary',
          right: {
            type: 'Index',
            subject: {
              type: 'PatternComprehension',
              pattern: { variable: 'p' },
              where: { key: 'x' },
              projection: { key: 'y' },
            },
          },
        },
      ],
    });
  });
});

describe('parse: CASE', () => {
  it('parses the simple and generic forms', () => {
    expect(expr("CASE a WHEN 1 THEN 'x' WHEN 2 THEN 'y' ELSE 'z' END")).toMatchObject({
      type: 'Case',
      subject: { type: 'Variable', name: 'a' },
      alternatives: [
        { when: { value: 1n }, then: { value: 'x' } },
        { when: { value: 2n }, then: { value: 'y' } },
      ],
      otherwise: { value: 'z' },
    });
    expect(expr('CASE WHEN a THEN 1 END')).toMatchObject({
      type: 'Case',
      subject: undefined,
      alternatives: [{ when: { type: 'Variable' }, then: { value: 1n } }],
      otherwise: undefined,
    });
  });
});

describe('parse: list expressions', () => {
  it('parses indexing, slicing, and chains with property lookups in order', () => {
    expect(expr('a.b[0].c')).toMatchObject({
      type: 'PropertyAccess',
      key: 'c',
      subject: {
        type: 'Index',
        index: { type: 'Literal', value: 0n },
        subject: { type: 'PropertyAccess', key: 'b', subject: { type: 'Variable', name: 'a' } },
      },
    });
    expect(expr('a[1..-1]')).toMatchObject({
      type: 'Slice',
      from: { value: 1n },
      to: { value: -1n },
    });
    expect(expr('a[..2]')).toMatchObject({ type: 'Slice', from: undefined, to: { value: 2n } });
    expect(expr('a[1..]')).toMatchObject({ type: 'Slice', from: { value: 1n }, to: undefined });
    expect(expr('a[..]')).toMatchObject({ type: 'Slice', from: undefined, to: undefined });
  });

  it('parses list comprehensions and quantifiers', () => {
    expect(expr('[x IN a WHERE x > 1 | x * 2]')).toMatchObject({
      type: 'ListComprehension',
      variable: 'x',
      list: { type: 'Variable', name: 'a' },
      where: { type: 'Binary', operator: '>' },
      projection: { type: 'Binary', operator: '*' },
    });
    expect(expr('[x IN a WHERE x]')).toMatchObject({
      type: 'ListComprehension',
      projection: undefined,
    });
    expect(expr('[x IN a | x]')).toMatchObject({ type: 'ListComprehension', where: undefined });
    for (const quantifier of ['all', 'any', 'none', 'single']) {
      expect(expr(`${quantifier.toUpperCase()}(x IN a WHERE x)`)).toMatchObject({
        type: 'Quantifier',
        quantifier,
        variable: 'x',
        where: { type: 'Variable', name: 'x' },
      });
    }
  });
});
