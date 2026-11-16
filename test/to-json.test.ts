import { afterAll, describe, expect, it } from 'vitest';
import {
  createGraph,
  CypherDuration,
  CypherNode,
  CypherPath,
  CypherRelationship,
  CypherTemporal,
  toJson,
} from '../src/index.js';
import { testBackends } from './support/backends.js';

describe('toJson', () => {
  const a = new CypherNode('1', ['P'], { name: 'Ada', age: 36n });
  const b = new CypherNode('2', [], {});
  const r = new CypherRelationship('5', 'KNOWS', '1', '2', { since: 1833n });

  it('writes entities with the reserved ~ keys and their properties', () => {
    expect(toJson(a)).toEqual({ '~id': '1', '~labels': ['P'], name: 'Ada', age: 36 });
    expect(toJson(r)).toEqual({
      '~id': '5',
      '~type': 'KNOWS',
      '~start': '1',
      '~end': '2',
      since: 1833,
    });
    expect(toJson(new CypherPath([a, b], [r]))).toEqual({
      '~nodes': [toJson(a), { '~id': '2', '~labels': [] }],
      '~relationships': [toJson(r)],
    });
  });

  it('writes scalars, temporal values, lists, and maps', () => {
    expect(
      toJson({
        n: null,
        t: true,
        s: 'x',
        f: 1.5,
        whole: 2.0,
        nan: Number.NaN,
        inf: -Infinity,
        d: new CypherTemporal('date', '2024-03-01'),
        dt: new CypherTemporal('datetime', '2024-03-01T10:00Z'),
        p: new CypherDuration('P1D'),
        l: [1n, [a], { k: 2n }],
      }),
    ).toEqual({
      n: null,
      t: true,
      s: 'x',
      f: 1.5,
      whole: 2,
      nan: 'NaN',
      inf: '-Infinity',
      d: '2024-03-01',
      dt: '2024-03-01T10:00Z',
      p: 'P1D',
      l: [1, [toJson(a)], { k: 2 }],
    });
  });

  it('writes integers as numbers when safe, or as asked', () => {
    const big = 9007199254740993n; // 2^53 + 1
    const values = [1n, -(2n ** 53n) + 1n, big, -big];
    expect(toJson(values)).toEqual([1, -(2 ** 53) + 1, '9007199254740993', '-9007199254740993']);
    expect(toJson(values, { integers: 'string' })).toEqual([
      '1',
      '-9007199254740991',
      '9007199254740993',
      '-9007199254740993',
    ]);
    expect(toJson(values, { integers: 'number' })).toEqual([
      1,
      -(2 ** 53) + 1,
      9007199254740992,
      -9007199254740992,
    ]);
  });

  it('gives a value JSON.stringify writes', () => {
    expect(JSON.stringify(toJson([{ n: a, c: 3n }]))).toBe(
      '[{"n":{"~id":"1","~labels":["P"],"name":"Ada","age":36},"c":3}]',
    );
  });
});

for (const backend of testBackends()) {
  describe(`toJson of query results on ${backend.name}`, () => {
    afterAll(() => backend.dispose?.());

    it('serializes records with nodes, relationships, paths, and counts', async () => {
      const { dialect, executor } = await backend.open();
      const graph = createGraph({ dialect, executor, readOnly: false });
      await graph.query("CREATE (:P {name: 'Ada'})-[:KNOWS {since: 1833}]->(:P {name: 'Alan'})");
      const records = await graph.query(
        "MATCH p = (a:P {name: 'Ada'})-[r]->(b) RETURN a, r, p, count(*) AS c, date('2024-03-01') AS d",
      );
      const json = toJson(records);
      const a = records[0]!['a'] as CypherNode;
      const r = records[0]!['r'] as CypherRelationship;
      const ada = { '~id': a.id, '~labels': ['P'], name: 'Ada' };
      const knows = {
        '~id': r.id,
        '~type': 'KNOWS',
        '~start': a.id,
        '~end': r.endNodeId,
        since: 1833,
      };
      expect(json).toEqual([
        {
          a: ada,
          r: knows,
          p: {
            '~nodes': [ada, { '~id': r.endNodeId, '~labels': ['P'], name: 'Alan' }],
            '~relationships': [knows],
          },
          c: 1,
          d: '2024-03-01',
        },
      ]);
      expect(() => JSON.stringify(json)).not.toThrow();
    });
  });
}
