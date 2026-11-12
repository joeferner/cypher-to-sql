import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createGraph,
  LimitExceededError,
  ReadOnlyViolationError,
  SemanticError,
  sqlite,
  type CypherValue,
  type Graph,
  type IdStrategy,
} from '../src/index.js';
import { createSqliteDatabase, sqliteExecutor } from './support/sqlite.js';

interface Fixture {
  db: Database.Database;
  write: Graph;
  read: Graph;
  count: (table: 'nodes' | 'edges') => bigint;
}

function setup(options: { idStrategy?: IdStrategy } = {}): Fixture {
  const db = createSqliteDatabase();
  const executor = sqliteExecutor(db);
  const write = createGraph({ dialect: sqlite(), executor, readOnly: false, ...options });
  const read = createGraph({ dialect: sqlite(), executor });
  const count = (table: 'nodes' | 'edges'): bigint =>
    (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c;
  return { db, write, read, count };
}

const column = (records: Record<string, CypherValue>[], name: string): CypherValue[] =>
  records.map((r) => r[name] ?? null);

describe('UNWIND', () => {
  it('keeps element types and list order', async () => {
    const { read } = setup();
    const records = await read.query(
      "UNWIND [3, 1.0, 'a', true, null, [1, 2.5], {k: 1}] AS x RETURN x",
    );
    expect(column(records, 'x')).toEqual([3n, 1.0, 'a', true, null, [1n, 2.5], { k: 1n }]);
    expect(typeof records[1]!['x']).toBe('number');
  });

  it('gives no rows for null and the empty list, and one row for a scalar', async () => {
    const { read } = setup();
    expect(await read.query('UNWIND null AS x RETURN x')).toEqual([]);
    expect(await read.query('UNWIND [] AS x RETURN x')).toEqual([]);
    expect(await read.query('UNWIND 5 AS x RETURN x')).toEqual([{ x: 5n }]);
  });

  it('unwinds parameters and nested lists, in nested-loop order', async () => {
    const { read } = setup();
    const records = await read.query('UNWIND $lists AS l UNWIND l AS x RETURN x', {
      lists: [[3n, 2n], [], [1n]],
    });
    expect(column(records, 'x')).toEqual([3n, 2n, 1n]);
  });

  it('reads properties of unwound maps', async () => {
    const { read } = setup();
    const records = await read.query('UNWIND [{a: {b: 1}}, {a: null}] AS m RETURN m.a.b AS b');
    expect(column(records, 'b')).toEqual([1n, null]);
  });

  it('rejects a variable that is already bound', () => {
    const { read } = setup();
    expect(() => read.compile('UNWIND [1] AS x UNWIND [2] AS x RETURN x')).toThrow(SemanticError);
  });
});

describe('MATCH / UNWIND with CREATE', () => {
  it('creates once per incoming row, with values from the row', async () => {
    const { write, read } = setup();
    await write.query('UNWIND [1, 2, 3] AS i CREATE (:N {num: i})');
    await write.query('MATCH (a:N), (b:N) CREATE (a)-[:T {from: a.num}]->(b)');
    const nums = await read.query('MATCH (n:N) RETURN n.num AS num');
    expect(column(nums, 'num').sort()).toEqual([1n, 2n, 3n]);
    const plan = write.compile('MATCH (a:N), (b:N) CREATE (a)-[:T]->(b)');
    expect(plan.steps.map((s) => s.perRow ?? false)).toEqual([false, true]);
  });

  it('runs the source step before any insert, so new nodes are not matched', async () => {
    const { write, count } = setup();
    await write.query('CREATE (:N), (:N)');
    await write.query('MATCH (n:N) CREATE (:N)');
    expect(count('nodes')).toBe(4n);
  });

  it('creates nothing when there are no rows', async () => {
    const { write, count } = setup();
    await write.query('MATCH (n:Missing) CREATE (n)-[:R]->(:New)');
    await write.query('UNWIND [] AS x CREATE ()');
    expect(count('nodes')).toBe(0n);
  });

  it('uses fresh entity ids for every row with an id generator', async () => {
    let next = 100;
    const { write, db } = setup({ idStrategy: { kind: 'generator', generate: () => next++ } });
    await write.query("UNWIND ['a', 'b'] AS c CREATE (:A {c: c})-[:R]->(:B)");
    const edges = db.prepare('SELECT start_id, end_id FROM edges ORDER BY id').all();
    expect(edges).toEqual([
      { start_id: 100n, end_id: 101n },
      { start_id: 103n, end_id: 104n },
    ]);
  });

  it('applies maxCreatedEntities to all rows before inserting', async () => {
    const { write, count } = setup();
    await expect(
      write.query(
        'UNWIND [1, 2, 3] AS i CREATE ()-[:R]->()',
        {},
        { limits: { maxCreatedEntities: 8 } },
      ),
    ).rejects.toThrow(LimitExceededError);
    expect(count('nodes')).toBe(0n);
  });

  it('rejects map property values from rows at run time', async () => {
    const { write, count } = setup();
    await expect(write.query('UNWIND [{a: 1}] AS m CREATE ({p: m})')).rejects.toThrow(
      SemanticError,
    );
    expect(count('nodes')).toBe(0n);
  });

  it('rejects invalid uses of bound variables', () => {
    const { write } = setup();
    expect(() => write.compile('MATCH (a) CREATE (a)')).toThrow(SemanticError);
    expect(() => write.compile('UNWIND [1] AS x CREATE (x)-[:R]->()')).toThrow(SemanticError);
    expect(() => write.compile('MATCH (a) CREATE (a:Label)-[:R]->()')).toThrow(SemanticError);
    expect(() => write.compile('MATCH (a) CREATE ({v: b.v})')).toThrow(SemanticError);
  });

  it('is rejected on a read-only graph', () => {
    const { read } = setup();
    expect(() => read.compile('UNWIND [1] AS i CREATE ()')).toThrow(ReadOnlyViolationError);
  });
});
