import { describe, expect, it } from 'vitest';
import {
  createGraph,
  defaultLimits,
  LimitExceededError,
  SemanticError,
  sqlite,
  type Graph,
  type GraphOptions,
  type Limits,
  type Row,
  type SqlExecutor,
  type SqlTx,
} from '../src/index.js';
import { lowerLimits } from '../src/limits.js';

/**
 * An executor that answers every SELECT with `rows` copies of one row and records
 * the bind values of each statement. INSERTs return a new id.
 */
function fakeExecutor(rows: number, delayMs = 0): SqlExecutor & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  let nextId = 1;
  return {
    calls,
    async transaction<T>(_mode: 'read' | 'write', fn: (tx: SqlTx) => Promise<T>): Promise<T> {
      return fn({
        async query(sql: string, values: unknown[]): Promise<Row[]> {
          calls.push(values);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (sql.startsWith('INSERT')) {
            return [{ id: nextId++ }];
          }
          return Array.from({ length: rows }, () => ({ c0: '1', r0: '1' }));
        },
      });
    },
  };
}

function graph(
  executor: SqlExecutor,
  limits: Partial<Limits> = {},
  options: Partial<GraphOptions> = {},
): Graph {
  return createGraph({ dialect: sqlite(), executor, limits, ...options });
}

/** The last bind value of the first statement: the step's LIMIT. */
const rowLimitOf = (executor: { calls: unknown[][] }): unknown => executor.calls[0]!.at(-1);

describe('lowerLimits', () => {
  it('only lowers, and keeps entries the override does not set', () => {
    const base: Limits = { ...defaultLimits, maxResultRows: 100, maxPathDepth: 5 };
    expect(lowerLimits(base, undefined)).toBe(base);
    expect(lowerLimits(base, { maxResultRows: 10, maxPathDepth: 50 })).toEqual({
      ...base,
      maxResultRows: 10,
      maxPathDepth: 5,
    });
  });
});

describe('row limits', () => {
  it('runs each step with LIMIT maxRowsPerStep + 1', async () => {
    const executor = fakeExecutor(1);
    await graph(executor, { maxRowsPerStep: 50 }).query('MATCH (n) RETURN n.x AS x');
    expect(rowLimitOf(executor)).toBe(51n);
  });

  it('uses the query LIMIT when it is lower, and the cap when it is higher', async () => {
    const low = fakeExecutor(1);
    await graph(low, { maxRowsPerStep: 50 }).query('MATCH (n) RETURN n.x AS x LIMIT 3');
    expect(rowLimitOf(low)).toBe(3n);

    const high = fakeExecutor(1);
    await graph(high, { maxRowsPerStep: 50 }).query('MATCH (n) RETURN n.x AS x LIMIT $n', {
      n: 1000n,
    });
    expect(rowLimitOf(high)).toBe(51n);
  });

  it('fails when a step returns the extra row, and passes at exactly the limit', async () => {
    const limits = { maxRowsPerStep: 5, maxResultRows: 100 };
    await expect(
      graph(fakeExecutor(5), limits).query('MATCH (n) RETURN n.x AS x'),
    ).resolves.toHaveLength(5);
    await expect(graph(fakeExecutor(6), limits).query('MATCH (n) RETURN n.x AS x')).rejects.toThrow(
      /maxRowsPerStep/,
    );
  });

  it('fails above maxResultRows with a hint to add LIMIT', async () => {
    const error = await graph(fakeExecutor(4), { maxResultRows: 3 })
      .query('MATCH (n) RETURN n.x AS x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LimitExceededError);
    expect((error as LimitExceededError).hint).toMatch(/LIMIT/);
  });

  it('lets a query lower the graph limits but not raise them', async () => {
    const g = graph(fakeExecutor(4), { maxResultRows: 5 });
    await expect(
      g.query('MATCH (n) RETURN n.x AS x', {}, { limits: { maxResultRows: 3 } }),
    ).rejects.toThrow(LimitExceededError);
    const capped = graph(fakeExecutor(6), { maxResultRows: 5 });
    await expect(
      capped.query('MATCH (n) RETURN n.x AS x', {}, { limits: { maxResultRows: 100 } }),
    ).rejects.toThrow(LimitExceededError);
  });

  it('validates LIMIT values', async () => {
    expect(() => graph(fakeExecutor(0)).compile('MATCH (n) RETURN n LIMIT 1.5')).toThrow(
      SemanticError,
    );
    await expect(
      graph(fakeExecutor(0)).query('MATCH (n) RETURN n LIMIT $n', { n: -1n }),
    ).rejects.toThrow(SemanticError);
  });
});

describe('other limits', () => {
  it('checks the timeout between steps', async () => {
    const g = graph(fakeExecutor(0, 20), { timeoutMs: 5 }, { readOnly: false });
    await expect(g.query('CREATE (), (), ()')).rejects.toThrow(/time limit of 5 ms/);
  });

  it('checks maxCreatedEntities when compiling a plain CREATE', () => {
    const g = graph(fakeExecutor(0), { maxCreatedEntities: 2 }, { readOnly: false });
    expect(() => g.compile('CREATE ()-[:R]->()')).toThrow(/maxCreatedEntities/);
    expect(() => g.compile('CREATE ()-[:R]->()', { limits: { maxCreatedEntities: 3 } })).toThrow(
      LimitExceededError,
    );
  });

  it('checks maxCreatedEntities against all source rows before inserting', async () => {
    const executor = fakeExecutor(3);
    const g = graph(executor, { maxCreatedEntities: 5 }, { readOnly: false });
    await expect(g.query('MATCH (n) CREATE (n)-[:R]->()')).rejects.toThrow(/maxCreatedEntities/);
    // Only the source SELECT ran.
    expect(executor.calls).toHaveLength(1);
  });
});
